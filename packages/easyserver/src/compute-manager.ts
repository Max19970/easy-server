import { createHash, randomUUID } from "node:crypto";
import {
  isNormalizedError,
  normalizedError,
  parseProviderInstanceList,
  parseProviderInstanceSnapshot,
  PluginContractError,
  type AvailableAction,
  type InstanceState,
  type NormalizedErrorCode,
  type OperationContext,
  type ProviderInstanceSnapshot,
  type ProviderRawState,
} from "@easyai101/easyserver-plugin-sdk";
import {
  acquireFilesystemLock,
  FilesystemLockCancelledError,
  FilesystemLockTimeoutError,
  type FilesystemLockLease,
} from "./filesystem-lock.js";
import { HostOperationRunner } from "./host-operation.js";
import {
  providerOperationContext,
  ProviderRegistry,
  type ProviderAdmission,
} from "./provider-registry.js";
import {
  JsonStateStore,
  type EasyServerState,
  type InstanceBinding,
  type InstanceManagement,
  type PendingManagedResource,
} from "./state-store.js";

export interface ComputeInstance {
  readonly id: string;
  readonly providerId: string;
  readonly providerExternalId: string;
  readonly management: InstanceManagement;
  readonly name?: string;
  readonly state: InstanceState;
  readonly rawState: ProviderRawState;
  readonly availableActions: readonly AvailableAction[];
}

export interface FreshInventoryInstance extends ComputeInstance {
  readonly freshness: "fresh";
  readonly observedAt: string;
}

export interface StaleInventoryInstance {
  readonly id: string;
  readonly providerId: string;
  readonly providerExternalId: string;
  readonly management: InstanceManagement;
  readonly name?: string;
  readonly state: InstanceState;
  readonly observedAt: string;
  readonly freshness: "stale";
  readonly availableActions: readonly [];
}

export interface UnobservedInventoryInstance {
  readonly id: string;
  readonly providerId: string;
  readonly providerExternalId: string;
  readonly management: InstanceManagement;
  readonly freshness: "unobserved";
  readonly availableActions: readonly [];
}

export type InventoryInstance =
  | FreshInventoryInstance
  | StaleInventoryInstance
  | UnobservedInventoryInstance;

export interface ProviderInventoryError {
  readonly code: NormalizedErrorCode;
  readonly message: string;
}

export type ProviderInventoryOutcome =
  | { readonly providerId: string; readonly status: "fresh" }
  | {
      readonly providerId: string;
      readonly status: "failed";
      readonly error: ProviderInventoryError;
    };

export interface InventoryResult {
  readonly instances: readonly InventoryInstance[];
  readonly providers: readonly ProviderInventoryOutcome[];
  readonly complete: boolean;
}

interface ProviderRefreshResult {
  readonly instances: readonly ComputeInstance[];
  readonly observedAt: string;
}

export class ComputeManager {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly stateStore: JsonStateStore,
    private readonly operations = new HostOperationRunner(),
  ) {}

  async listInstances(context: OperationContext): Promise<readonly ComputeInstance[]> {
    const providerIds = this.registry.listProviderIds();
    const refreshed = await Promise.all(
      providerIds.map((providerId) => this.refreshProvider(providerId, context)),
    );
    return refreshed.flat();
  }

  async listInventory(context: OperationContext): Promise<InventoryResult> {
    const before = await this.stateStore.read();
    const providerIds = orderedProviderIds(
      this.registry.listProviderIds(),
      before.instances ?? [],
    );
    const attempts = await Promise.all(
      providerIds.map(async (providerId) => {
        try {
          const refreshed = await this.refreshRegisteredProvider(providerId, context);
          if (refreshed === undefined) {
            return {
              providerId,
              status: "failed" as const,
              error: providerInventoryError(
                providerId,
                normalizedError(
                  "provider-unavailable",
                  `Provider is not available: ${providerId}`,
                ),
              ),
            };
          }
          return { providerId, status: "fresh" as const, refreshed };
        } catch (error) {
          return {
            providerId,
            status: "failed" as const,
            error: providerInventoryError(providerId, error),
          };
        }
      }),
    );

    if (context.signal.aborted) {
      throw normalizedError("cancelled", "Provider inventory refresh was cancelled");
    }

    const after = await this.stateStore.read();
    const instances: InventoryInstance[] = [];
    const providers: ProviderInventoryOutcome[] = [];
    for (const attempt of attempts) {
      if (attempt.status === "fresh") {
        providers.push({ providerId: attempt.providerId, status: "fresh" });
        instances.push(
          ...attempt.refreshed.instances.map((instance) => ({
            ...instance,
            freshness: "fresh" as const,
            observedAt: attempt.refreshed.observedAt,
          })),
        );
        continue;
      }

      providers.push({
        providerId: attempt.providerId,
        status: "failed",
        error: attempt.error,
      });
      instances.push(
        ...(after.instances ?? [])
          .filter((binding) => binding.providerId === attempt.providerId)
          .map(toDegradedInventoryInstance),
      );
    }

    return {
      instances,
      providers,
      complete: providers.every((provider) => provider.status === "fresh"),
    };
  }

  async refreshProvider(
    providerId: string,
    context: OperationContext,
  ): Promise<readonly ComputeInstance[]> {
    const refreshed = await this.refreshRegisteredProvider(providerId, context);
    if (refreshed === undefined) {
      throw normalizedError(
        "provider-unavailable",
        `Provider is not available: ${providerId}`,
      );
    }
    return refreshed.instances;
  }

  async recordAcquiredProviderResources(
    providerId: string,
    providerExternalIds: readonly string[],
  ): Promise<void> {
    if (providerExternalIds.length === 0) {
      return;
    }

    await this.stateStore.update((state) => {
      let changed = false;
      const managedIds = new Set(providerExternalIds);
      const instances = (state.instances ?? []).map((binding) => {
        if (
          binding.providerId === providerId &&
          managedIds.has(binding.providerExternalId) &&
          binding.management !== "managed"
        ) {
          changed = true;
          return { ...binding, management: "managed" as const };
        }
        return binding;
      });
      const bound = new Set(
        instances
          .filter((binding) => binding.providerId === providerId)
          .map((binding) => binding.providerExternalId),
      );
      const pending = [...(state.pendingManagedResources ?? [])];
      const pendingKeys = new Set(
        pending.map((resource) =>
          providerResourceKey(resource.providerId, resource.providerExternalId),
        ),
      );
      for (const providerExternalId of providerExternalIds) {
        if (bound.has(providerExternalId)) {
          continue;
        }
        const key = providerResourceKey(providerId, providerExternalId);
        if (!pendingKeys.has(key)) {
          pendingKeys.add(key);
          pending.push({ providerId, providerExternalId });
          changed = true;
        }
      }

      if (!changed) {
        return state;
      }
      return {
        ...state,
        ...(instances.length === 0 ? {} : { instances }),
        ...(pending.length === 0 ? {} : { pendingManagedResources: pending }),
      };
    });
  }

  async adoptInstance(id: string): Promise<void> {
    let found = false;
    await this.stateStore.update((state) => {
      const instances = (state.instances ?? []).map((binding) => {
        if (binding.id !== id) {
          return binding;
        }
        found = true;
        return binding.management === "managed"
          ? binding
          : { ...binding, management: "managed" as const };
      });
      if (!found) {
        return state;
      }
      const current = state.instances?.find((binding) => binding.id === id);
      return current?.management === "managed"
        ? state
        : { ...state, instances };
    });
    if (!found) {
      throw normalizedError("not-found", `Compute Instance not found: ${id}`);
    }
  }

  async inspectInstance(
    id: string,
    context: OperationContext,
  ): Promise<ComputeInstance | undefined> {
    const state = await this.stateStore.read();
    const binding = state.instances?.find((candidate) => candidate.id === id);
    if (binding === undefined) {
      return undefined;
    }

    const admission = this.registry.acquire(binding.providerId);
    if (admission === undefined) {
      throw new Error(`Provider is not available: ${binding.providerId}`);
    }

    try {
      const value = await this.operations.run(
        "read",
        `Provider ${binding.providerId} getInstance`,
        context,
        (operationContext) =>
          admission.provider.getInstance(
            binding.providerExternalId,
            providerOperationContext(admission, operationContext),
          ),
      );

      if (value === undefined) {
        await this.removeBinding(state, binding.id);
        return undefined;
      }

      const snapshot = parseProviderInstanceSnapshot(value, admission.capabilities);
      assertRequestedIdentity(snapshot, binding.providerExternalId);
      return toComputeInstance(binding, snapshot);
    } finally {
      admission.release();
    }
  }

  async performAction(
    id: string,
    action: AvailableAction,
    context: OperationContext,
  ): Promise<void> {
    const state = await this.stateStore.read();
    const binding = state.instances?.find((candidate) => candidate.id === id);
    if (binding === undefined) {
      throw normalizedError("not-found", `Compute Instance not found: ${id}`);
    }

    if (action === "instance.destroy" && binding.management !== "managed") {
      throw normalizedError(
        "conflict",
        `Compute Instance ${id} is discovered/unmanaged; adopt it before destroy`,
      );
    }

    const admission = this.registry.acquire(binding.providerId);
    if (admission === undefined) {
      throw normalizedError(
        "provider-unavailable",
        `Provider is not available: ${binding.providerId}`,
      );
    }

    try {
      if (!admission.capabilities.includes(action)) {
        throw normalizedError(
          "unsupported-operation",
          `Provider ${binding.providerId} does not support ${action}`,
        );
      }

      const before = await this.operations.run(
        "read",
        `Provider ${binding.providerId} getInstance`,
        context,
        (operationContext) =>
          admission.provider.getInstance(
            binding.providerExternalId,
            providerOperationContext(admission, operationContext),
          ),
      );
      if (before === undefined) {
        await this.removeBinding(state, binding.id);
        throw normalizedError("not-found", `Compute Instance not found: ${id}`);
      }

      const current = parseProviderInstanceSnapshot(before, admission.capabilities);
      assertRequestedIdentity(current, binding.providerExternalId);
      if (!current.availableActions.includes(action)) {
        throw normalizedError(
          "conflict",
          `${action} is not available for Compute Instance ${id}`,
        );
      }

      try {
        if (action === "instance.destroy") {
          if (admission.provider.destroy === undefined) {
            throw normalizedError(
              "plugin-failure",
              `Provider ${binding.providerId} declared ${action} without destroy()`,
            );
          }
          await this.operations.run(
            "mutation",
            `Provider ${binding.providerId} ${action}`,
            context,
            (operationContext) =>
              admission.provider.destroy!(
                binding.providerExternalId,
                providerOperationContext(admission, operationContext),
              ),
          );
        } else {
          if (admission.provider.performPowerAction === undefined) {
            throw normalizedError(
              "plugin-failure",
              `Provider ${binding.providerId} declared ${action} without performPowerAction()`,
            );
          }
          await this.operations.run(
            "mutation",
            `Provider ${binding.providerId} ${action}`,
            context,
            (operationContext) =>
              admission.provider.performPowerAction!(
                binding.providerExternalId,
                action,
                providerOperationContext(admission, operationContext),
              ),
          );
        }
      } catch (error) {
        if (
          isNormalizedError(error) &&
          (error.code === "conflict" || error.code === "outcome-unknown")
        ) {
          await this.refreshBindingAfterMutation(
            state,
            binding,
            admission,
          ).catch(() => undefined);
        }
        throw error;
      }
    } finally {
      admission.release();
    }
  }

  private async refreshRegisteredProvider(
    providerId: string,
    context: OperationContext,
  ): Promise<ProviderRefreshResult | undefined> {
    const admission = this.registry.acquire(providerId);
    if (admission === undefined) {
      return undefined;
    }

    let refreshLock: FilesystemLockLease | undefined;
    try {
      refreshLock = await acquireProviderRefreshLock(
        this.stateStore.path,
        providerId,
        context.signal,
      );
      const snapshots = parseProviderInstanceList(
        await this.operations.run(
          "read",
          `Provider ${providerId} listInstances`,
          context,
          (operationContext) =>
            admission.provider.listInstances(
              providerOperationContext(admission, operationContext),
            ),
        ),
        admission.capabilities,
      );

      const observedAt = new Date().toISOString();
      let instances: readonly ComputeInstance[] = [];
      await this.stateStore.update(async (state) => {
        await refreshLock!.assertOwned();
        const reconciled = reconcileProviderInventory(
          state,
          providerId,
          snapshots,
          observedAt,
        );
        instances = reconciled.instances;
        return reconciled.state;
      });
      return { instances, observedAt };
    } finally {
      try {
        await refreshLock?.release();
      } finally {
        admission.release();
      }
    }
  }

  private async refreshBindingAfterMutation(
    state: EasyServerState,
    binding: InstanceBinding,
    admission: ProviderAdmission,
  ): Promise<void> {
    const reconciliationContext = { signal: new AbortController().signal };
    const snapshot = await this.operations.run(
      "read",
      `Provider ${binding.providerId} reconcile instance`,
      reconciliationContext,
      (operationContext) =>
        admission.provider.getInstance(
          binding.providerExternalId,
          providerOperationContext(admission, operationContext),
        ),
    );
    if (snapshot === undefined) {
      await this.removeBinding(state, binding.id);
      return;
    }

    assertRequestedIdentity(
      parseProviderInstanceSnapshot(snapshot, admission.capabilities),
      binding.providerExternalId,
    );
  }

  private async removeBinding(_state: EasyServerState, id: string): Promise<void> {
    await this.stateStore.update((state) => {
      const instances = (state.instances ?? []).filter(
        (binding) => binding.id !== id,
      );
      return instances.length === (state.instances ?? []).length
        ? state
        : { ...state, instances };
    });
  }
}

async function acquireProviderRefreshLock(
  statePath: string,
  providerId: string,
  signal: AbortSignal,
): Promise<FilesystemLockLease> {
  const providerKey = createHash("sha256").update(providerId).digest("hex");
  try {
    return await acquireFilesystemLock(
      `${statePath}.provider-refresh.${providerKey}.lock`,
      { timeoutMs: 65_000, signal },
    );
  } catch (error) {
    if (error instanceof FilesystemLockCancelledError) {
      throw normalizedError(
        "cancelled",
        `Provider ${providerId} inventory refresh was cancelled`,
      );
    }
    if (error instanceof FilesystemLockTimeoutError) {
      throw normalizedError(
        "timeout",
        `Timed out waiting for Provider ${providerId} inventory refresh`,
      );
    }
    throw error;
  }
}

function reconcileProviderInventory(
  state: EasyServerState,
  providerId: string,
  snapshots: readonly ProviderInstanceSnapshot[],
  observedAt: string,
): { readonly state: EasyServerState; readonly instances: readonly ComputeInstance[] } {
  const previousBindings = state.instances ?? [];
  const pendingManagedResources = state.pendingManagedResources ?? [];
  const pendingManagedIds = new Set(
    pendingManagedResources
      .filter((resource) => resource.providerId === providerId)
      .map((resource) => resource.providerExternalId),
  );
  const existing = new Map(
    previousBindings
      .filter((binding) => binding.providerId === providerId)
      .map((binding) => [binding.providerExternalId, binding]),
  );
  const currentBindings: InstanceBinding[] = [];
  const instances: ComputeInstance[] = [];
  const observedExternalIds = new Set<string>();

  for (const snapshot of snapshots) {
    observedExternalIds.add(snapshot.providerExternalId);
    const shouldBeManaged = pendingManagedIds.has(snapshot.providerExternalId);
    const existingBinding = existing.get(snapshot.providerExternalId);
    const baseBinding =
      existingBinding === undefined
        ? newBinding(
            providerId,
            snapshot.providerExternalId,
            shouldBeManaged ? "managed" : "discovered",
          )
        : shouldBeManaged && existingBinding.management !== "managed"
          ? { ...existingBinding, management: "managed" as const }
          : existingBinding;
    const binding = withObservation(baseBinding, snapshot, observedAt);
    currentBindings.push(binding);
    instances.push(toComputeInstance(binding, snapshot));
  }

  const bindings = [
    ...previousBindings.filter((binding) => binding.providerId !== providerId),
    ...currentBindings,
  ];
  const remainingPending = pendingManagedResources.filter(
    (resource) =>
      resource.providerId !== providerId ||
      !observedExternalIds.has(resource.providerExternalId),
  );
  const changed =
    !sameBindings(previousBindings, bindings) ||
    !samePendingManagedResources(pendingManagedResources, remainingPending);
  return {
    state: changed
      ? withReconciledState(state, bindings, remainingPending)
      : state,
    instances,
  };
}

function assertRequestedIdentity(
  snapshot: ProviderInstanceSnapshot,
  providerExternalId: string,
): void {
  if (snapshot.providerExternalId !== providerExternalId) {
    throw new PluginContractError(
      `provider getInstance returned ${snapshot.providerExternalId} for requested ${providerExternalId}`,
    );
  }
}

function orderedProviderIds(
  registeredProviderIds: readonly string[],
  bindings: readonly InstanceBinding[],
): readonly string[] {
  const ids = [...registeredProviderIds];
  const seen = new Set(ids);
  for (const binding of bindings) {
    if (!seen.has(binding.providerId)) {
      seen.add(binding.providerId);
      ids.push(binding.providerId);
    }
  }
  return ids;
}

function providerInventoryError(
  providerId: string,
  error: unknown,
): ProviderInventoryError {
  return {
    code: isNormalizedError(error) ? error.code : "plugin-failure",
    message: `Provider ${providerId} inventory refresh failed`,
  };
}

function toDegradedInventoryInstance(binding: InstanceBinding): InventoryInstance {
  const observation = binding.observation;
  if (observation === undefined) {
    return {
      id: binding.id,
      providerId: binding.providerId,
      providerExternalId: binding.providerExternalId,
      management: binding.management,
      freshness: "unobserved",
      availableActions: [],
    };
  }

  return {
    id: binding.id,
    providerId: binding.providerId,
    providerExternalId: binding.providerExternalId,
    management: binding.management,
    state: observation.state,
    observedAt: observation.observedAt,
    freshness: "stale",
    availableActions: [],
    ...(observation.name === undefined ? {} : { name: observation.name }),
  };
}

function newBinding(
  providerId: string,
  providerExternalId: string,
  management: InstanceManagement,
): InstanceBinding {
  return {
    id: `instance:${randomUUID()}`,
    providerId,
    providerExternalId,
    management,
  };
}

function withObservation(
  binding: InstanceBinding,
  snapshot: ProviderInstanceSnapshot,
  observedAt: string,
): InstanceBinding {
  return {
    ...binding,
    observation: {
      state: snapshot.state,
      observedAt,
      ...(snapshot.name === undefined ? {} : { name: snapshot.name }),
    },
  };
}

function toComputeInstance(
  binding: InstanceBinding,
  snapshot: ProviderInstanceSnapshot,
): ComputeInstance {
  const instance: ComputeInstance = {
    id: binding.id,
    providerId: binding.providerId,
    providerExternalId: binding.providerExternalId,
    management: binding.management,
    state: snapshot.state,
    rawState: snapshot.rawState,
    availableActions: snapshot.availableActions,
  };

  return snapshot.name === undefined ? instance : { ...instance, name: snapshot.name };
}

function sameBindings(
  left: readonly InstanceBinding[],
  right: readonly InstanceBinding[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (binding, index) =>
        binding.id === right[index]?.id &&
        binding.providerId === right[index]?.providerId &&
        binding.providerExternalId === right[index]?.providerExternalId &&
        binding.management === right[index]?.management &&
        binding.observation?.state === right[index]?.observation?.state &&
        binding.observation?.observedAt === right[index]?.observation?.observedAt &&
        binding.observation?.name === right[index]?.observation?.name,
    )
  );
}

function samePendingManagedResources(
  left: readonly PendingManagedResource[],
  right: readonly PendingManagedResource[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (resource, index) =>
        resource.providerId === right[index]?.providerId &&
        resource.providerExternalId === right[index]?.providerExternalId,
    )
  );
}

function withReconciledState(
  state: EasyServerState,
  instances: readonly InstanceBinding[],
  pendingManagedResources: readonly PendingManagedResource[],
): EasyServerState {
  const { pendingManagedResources: _previousPending, ...base } = state;
  return {
    ...base,
    instances,
    ...(pendingManagedResources.length === 0
      ? {}
      : { pendingManagedResources }),
  };
}

function providerResourceKey(providerId: string, providerExternalId: string): string {
  return `${providerId}\u0000${providerExternalId}`;
}
