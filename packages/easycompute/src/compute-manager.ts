import { randomUUID } from "node:crypto";
import {
  isNormalizedError,
  normalizedError,
  parseProviderInstanceList,
  parseProviderInstanceSnapshot,
  PluginContractError,
  type AvailableAction,
  type InstanceState,
  type OperationContext,
  type ProviderInstanceSnapshot,
  type ProviderRawState,
} from "@easycompute/plugin-sdk";
import {
  providerOperationContext,
  ProviderRegistry,
  type ProviderAdmission,
} from "./provider-registry.js";
import {
  JsonStateStore,
  type EasyComputeState,
  type InstanceBinding,
} from "./state-store.js";

export interface ComputeInstance {
  readonly id: string;
  readonly providerId: string;
  readonly providerExternalId: string;
  readonly name?: string;
  readonly state: InstanceState;
  readonly rawState: ProviderRawState;
  readonly availableActions: readonly AvailableAction[];
}

export class ComputeManager {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly stateStore: JsonStateStore,
  ) {}

  async listInstances(context: OperationContext): Promise<readonly ComputeInstance[]> {
    const snapshotsByProvider = new Map<
      string,
      readonly ProviderInstanceSnapshot[]
    >();

    for (const providerId of this.registry.listProviderIds()) {
      const admission = this.registry.acquire(providerId);
      if (admission === undefined) {
        continue;
      }

      try {
        snapshotsByProvider.set(
          providerId,
          parseProviderInstanceList(
            await admission.provider.listInstances(
              providerOperationContext(admission, context),
            ),
            admission.capabilities,
          ),
        );
      } finally {
        admission.release();
      }
    }

    const instances: ComputeInstance[] = [];
    await this.stateStore.update((state) => {
      let nextState = state;
      for (const [providerId, snapshots] of snapshotsByProvider) {
        const reconciled = reconcileProviderInventory(
          nextState,
          providerId,
          snapshots,
        );
        nextState = reconciled.state;
        instances.push(...reconciled.instances);
      }
      return nextState;
    });

    return instances;
  }

  async refreshProvider(
    providerId: string,
    context: OperationContext,
  ): Promise<readonly ComputeInstance[]> {
    const admission = this.registry.acquire(providerId);
    if (admission === undefined) {
      throw normalizedError(
        "provider-unavailable",
        `Provider is not available: ${providerId}`,
      );
    }

    let snapshots: readonly ProviderInstanceSnapshot[];
    try {
      snapshots = parseProviderInstanceList(
        await admission.provider.listInstances(
          providerOperationContext(admission, context),
        ),
        admission.capabilities,
      );
    } finally {
      admission.release();
    }

    let instances: readonly ComputeInstance[] = [];
    await this.stateStore.update((state) => {
      const reconciled = reconcileProviderInventory(state, providerId, snapshots);
      instances = reconciled.instances;
      return reconciled.state;
    });
    return instances;
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
      const value = await admission.provider.getInstance(
        binding.providerExternalId,
        providerOperationContext(admission, context),
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

      const providerContext = providerOperationContext(admission, context);
      const before = await admission.provider.getInstance(
        binding.providerExternalId,
        providerContext,
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
          await admission.provider.destroy(binding.providerExternalId, providerContext);
        } else {
          if (admission.provider.performPowerAction === undefined) {
            throw normalizedError(
              "plugin-failure",
              `Provider ${binding.providerId} declared ${action} without performPowerAction()`,
            );
          }
          await admission.provider.performPowerAction(
            binding.providerExternalId,
            action,
            providerContext,
          );
        }
      } catch (error) {
        if (isNormalizedError(error) && error.code === "conflict") {
          await this.refreshBindingAfterConflict(
            state,
            binding,
            admission,
            context,
          ).catch(() => undefined);
        }
        throw error;
      }
    } finally {
      admission.release();
    }
  }

  private async refreshBindingAfterConflict(
    state: EasyComputeState,
    binding: InstanceBinding,
    admission: ProviderAdmission,
    context: OperationContext,
  ): Promise<void> {
    const snapshot = await admission.provider.getInstance(
      binding.providerExternalId,
      providerOperationContext(admission, context),
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

  private async removeBinding(_state: EasyComputeState, id: string): Promise<void> {
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

function reconcileProviderInventory(
  state: EasyComputeState,
  providerId: string,
  snapshots: readonly ProviderInstanceSnapshot[],
): { readonly state: EasyComputeState; readonly instances: readonly ComputeInstance[] } {
  const previousBindings = state.instances ?? [];
  const existing = new Map(
    previousBindings
      .filter((binding) => binding.providerId === providerId)
      .map((binding) => [binding.providerExternalId, binding]),
  );
  const currentBindings: InstanceBinding[] = [];
  const instances: ComputeInstance[] = [];

  for (const snapshot of snapshots) {
    const binding =
      existing.get(snapshot.providerExternalId) ??
      newBinding(providerId, snapshot.providerExternalId);
    currentBindings.push(binding);
    instances.push(toComputeInstance(binding, snapshot));
  }

  const bindings = [
    ...previousBindings.filter((binding) => binding.providerId !== providerId),
    ...currentBindings,
  ];
  return {
    state: sameBindings(previousBindings, bindings)
      ? state
      : { ...state, instances: bindings },
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

function newBinding(providerId: string, providerExternalId: string): InstanceBinding {
  return {
    id: `instance:${randomUUID()}`,
    providerId,
    providerExternalId,
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
        binding.providerExternalId === right[index]?.providerExternalId,
    )
  );
}
