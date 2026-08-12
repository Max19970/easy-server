import {
  normalizedError,
  type AvailableAction,
  type OperationContext,
} from "@easyai101/easyserver-plugin-sdk";
import type { ComputeManager } from "./compute-manager.js";
import {
  acquireFilesystemLock,
  type FilesystemLockLease,
} from "./filesystem-lock.js";
import {
  LocalDaemonClient,
  readLocalDaemonDescriptor,
  type LocalDaemonDescriptor,
} from "./local-daemon.js";
import {
  requireMutationConfirmation,
  type MutationConfirmationPrompt,
} from "./mutation-safety.js";
import type {
  InstanceBinding,
  JsonStateStore,
} from "./state-store.js";
import { escapeTerminalText } from "./terminal-text.js";

export interface InstanceDestroyImpact {
  readonly sessionIds: readonly string[];
  readonly endpointIntentNames: readonly string[];
  readonly pendingCleanupCount: number;
  readonly affectedCount: number;
}

export interface InstanceDestroyConfirmationDetails {
  readonly instanceId: string;
  readonly providerId: string;
  readonly management: InstanceBinding["management"];
  readonly impact: InstanceDestroyImpact;
}

export interface InstanceOperationInteraction {
  readonly assumeYes?: boolean;
  warning?(message: string): void;
  confirm?(
    prompt: MutationConfirmationPrompt,
    details: InstanceDestroyConfirmationDetails,
    context: OperationContext,
  ): Promise<boolean>;
}

export interface PerformInstanceActionRequest {
  readonly instanceId: string;
  readonly action: AvailableAction;
  readonly context: OperationContext;
  readonly closeConnections?: boolean;
  readonly interaction?: InstanceOperationInteraction;
}

export interface InstanceDestroyConnectionGuard extends InstanceDestroyImpact {
  closeAffectedConnections(): Promise<void>;
  release(): Promise<void>;
}

interface InstanceManagerPort {
  adoptInstance(instanceId: string): Promise<void>;
  performAction(
    instanceId: string,
    action: AvailableAction,
    context: OperationContext,
  ): Promise<void>;
}

export interface InstanceOperationsDependencies {
  readonly manager: InstanceManagerPort;
  readBinding(instanceId: string): Promise<InstanceBinding | undefined>;
  acquireDestroyGuard(instanceId: string): Promise<InstanceDestroyConnectionGuard>;
}

export class InstanceOperations {
  readonly manager: InstanceManagerPort;
  readonly #readBinding: InstanceOperationsDependencies["readBinding"];
  readonly #acquireDestroyGuard: InstanceOperationsDependencies["acquireDestroyGuard"];

  constructor(dependencies: InstanceOperationsDependencies) {
    this.manager = dependencies.manager;
    this.#readBinding = dependencies.readBinding;
    this.#acquireDestroyGuard = dependencies.acquireDestroyGuard;
  }

  async adopt(instanceId: string): Promise<void> {
    await this.manager.adoptInstance(instanceId);
  }

  async perform(request: PerformInstanceActionRequest): Promise<void> {
    if (request.action !== "instance.destroy") {
      await this.manager.performAction(
        request.instanceId,
        request.action,
        request.context,
      );
      return;
    }

    const binding = await this.#readBinding(request.instanceId);
    if (binding === undefined) {
      throw normalizedError(
        "not-found",
        `Compute Instance not found: ${request.instanceId}`,
      );
    }
    if (binding.management !== "managed") {
      throw normalizedError(
        "conflict",
        `Compute Instance ${request.instanceId} is discovered/unmanaged; adopt it before destroy`,
      );
    }

    const guard = await this.#acquireDestroyGuard(request.instanceId);
    try {
      if (guard.affectedCount > 0 && request.closeConnections !== true) {
        throw normalizedError(
          "conflict",
          `Compute Instance ${request.instanceId} has EasyServer connections (${formatDestroyConnectionImpact(guard)}); close them first or rerun with --close-sessions`,
        );
      }

      const details: InstanceDestroyConfirmationDetails = {
        instanceId: request.instanceId,
        providerId: binding.providerId,
        management: binding.management,
        impact: destroyImpact(guard),
      };
      const confirmation = request.interaction;
      await requireMutationConfirmation(
        `Destroy Compute Instance ${request.instanceId} (provider=${binding.providerId}, management=${binding.management})`,
        ["destructive"],
        request.context,
        {
          assumeYes: confirmation?.assumeYes === true,
          interactive: confirmation?.confirm !== undefined,
          ...(confirmation?.confirm === undefined
            ? {}
            : {
                confirm: (prompt, context) =>
                  confirmation.confirm!(
                    {
                      ...prompt,
                      consequence: withDestroyImpact(
                        prompt.consequence,
                        guard,
                        request.closeConnections === true,
                      ),
                    },
                    details,
                    context,
                  ),
              }),
        },
      );

      if (request.closeConnections === true) {
        await guard.closeAffectedConnections();
      }
      await this.manager.performAction(
        request.instanceId,
        request.action,
        request.context,
      );
    } finally {
      try {
        await guard.release();
      } catch {
        try {
          request.interaction?.warning?.(
            "Failed to release the daemon connection-drain guard; restart the daemon before creating new connections for this instance.",
          );
        } catch {
          // A frontend warning sink must never overwrite the mutation outcome.
        }
      }
    }
  }
}

export function createInstanceOperations(
  manager: ComputeManager,
  stateStore: JsonStateStore,
  daemonFile: string,
): InstanceOperations {
  return new InstanceOperations({
    manager,
    async readBinding(instanceId) {
      return (await stateStore.read()).instances?.find(
        (binding) => binding.id === instanceId,
      );
    },
    acquireDestroyGuard: (instanceId) =>
      acquireInstanceDestroyConnectionGuard(
        instanceId,
        stateStore,
        daemonFile,
      ),
  });
}

async function acquireInstanceDestroyConnectionGuard(
  instanceId: string,
  store: JsonStateStore,
  daemonFile: string,
): Promise<InstanceDestroyConnectionGuard> {
  let managedLock: FilesystemLockLease | undefined;
  let lifecycleLock: FilesystemLockLease | undefined;
  let client: LocalDaemonClient | undefined;
  let drainToken: string | undefined;
  let released = false;

  const releaseLocks = async (): Promise<void> => {
    try {
      await lifecycleLock?.release();
    } finally {
      await managedLock?.release();
    }
  };

  try {
    managedLock = await acquireFilesystemLock(`${daemonFile}.managed.lock`, {
      timeoutMs: 35_000,
    });
    lifecycleLock = await acquireFilesystemLock(`${daemonFile}.lifecycle.lock`, {
      timeoutMs: 35_000,
    });

    const daemon = await inspectManagedDaemon(daemonFile);
    if (daemon.status === "stale") {
      throw normalizedError(
        "conflict",
        `EasyServer daemon is stale/unreachable (${daemon.reason}); cannot safely determine active connections before destroy`,
      );
    }

    if (daemon.status === "running") {
      client = new LocalDaemonClient(
        daemon.descriptor.address,
        daemon.descriptor.authToken,
      );
      const drain = await client.beginInstanceConnectionDrain(instanceId);
      drainToken = drain.token;
      const sessionIds = [...drain.sessionIds];
      const endpointIntentNames = [...drain.endpointIntentNames];
      const pendingCleanupCount = drain.pendingCleanupCount;

      return {
        sessionIds,
        endpointIntentNames,
        pendingCleanupCount,
        affectedCount:
          sessionIds.length + endpointIntentNames.length + pendingCleanupCount,
        async closeAffectedConnections() {
          try {
            await client!.closeInstanceConnectionsForDrain(drainToken!);
          } catch (error) {
            throw normalizedError(
              "conflict",
              `Failed to close all EasyServer connections for ${instanceId}; instance destroy was not dispatched`,
              error,
            );
          }
        },
        async release() {
          if (released) {
            return;
          }
          released = true;
          try {
            if (drainToken !== undefined) {
              await client!.releaseInstanceConnectionDrain(drainToken);
            }
          } finally {
            await releaseLocks();
          }
        },
      };
    }

    const state = await store.read();
    const endpointIntentNames = (state.endpointIntents ?? [])
      .filter((intent) => intent.instanceId === instanceId && intent.enabled)
      .map((intent) => intent.name);

    return {
      sessionIds: [],
      endpointIntentNames,
      pendingCleanupCount: 0,
      affectedCount: endpointIntentNames.length,
      async closeAffectedConnections() {
        if (endpointIntentNames.length === 0) {
          return;
        }
        await store.update((state) => ({
          ...state,
          endpointIntents: (state.endpointIntents ?? []).map((intent) =>
            intent.instanceId === instanceId && intent.enabled
              ? { ...intent, enabled: false }
              : intent,
          ),
        }));
        const fresh = await store.read();
        if (
          (fresh.endpointIntents ?? []).some(
            (intent) => intent.instanceId === instanceId && intent.enabled,
          )
        ) {
          throw normalizedError(
            "conflict",
            `Enabled Endpoint intents remain for ${instanceId}; instance destroy was not dispatched`,
          );
        }
      },
      async release() {
        if (released) {
          return;
        }
        released = true;
        await releaseLocks();
      },
    };
  } catch (error) {
    try {
      if (drainToken !== undefined && client !== undefined) {
        await client
          .releaseInstanceConnectionDrain(drainToken)
          .catch(() => undefined);
      }
    } finally {
      await releaseLocks().catch(() => undefined);
    }
    throw error;
  }
}

type ManagedDaemonState =
  | { readonly status: "running"; readonly descriptor: LocalDaemonDescriptor }
  | { readonly status: "stopped" }
  | { readonly status: "stale"; readonly reason: string };

async function inspectManagedDaemon(
  daemonFile: string,
): Promise<ManagedDaemonState> {
  let descriptor: LocalDaemonDescriptor | undefined;
  try {
    descriptor = await readLocalDaemonDescriptor(daemonFile);
  } catch {
    return { status: "stale", reason: "descriptor is invalid" };
  }
  if (descriptor === undefined) {
    return { status: "stopped" };
  }
  try {
    await new LocalDaemonClient(descriptor.address, descriptor.authToken).ping();
    return { status: "running", descriptor };
  } catch {
    return {
      status: "stale",
      reason: "authenticated health check failed",
    };
  }
}

function destroyImpact(
  guard: InstanceDestroyConnectionGuard,
): InstanceDestroyImpact {
  return {
    sessionIds: [...guard.sessionIds],
    endpointIntentNames: [...guard.endpointIntentNames],
    pendingCleanupCount: guard.pendingCleanupCount,
    affectedCount: guard.affectedCount,
  };
}

function formatDestroyConnectionImpact(impact: InstanceDestroyImpact): string {
  const parts: string[] = [];
  if (impact.sessionIds.length > 0) {
    parts.push(
      `sessions=${impact.sessionIds.length} [${impact.sessionIds.map(escapeTerminalText).join(", ")}]`,
    );
  }
  if (impact.endpointIntentNames.length > 0) {
    parts.push(
      `endpoint-intents=${impact.endpointIntentNames.length} [${impact.endpointIntentNames.map(escapeTerminalText).join(", ")}]`,
    );
  }
  if (impact.pendingCleanupCount > 0) {
    parts.push(`pending-cleanups=${impact.pendingCleanupCount}`);
  }
  return parts.join("; ");
}

function withDestroyImpact(
  base: string,
  impact: InstanceDestroyImpact,
  closeConnections: boolean,
): string {
  if (impact.affectedCount === 0) {
    return `${base}; no active EasyServer connections are currently affected`;
  }

  const parts: string[] = [];
  if (impact.sessionIds.length > 0) {
    parts.push(
      `${impact.sessionIds.length} active ${plural(impact.sessionIds.length, "session", "sessions")}`,
    );
  }
  if (impact.endpointIntentNames.length > 0) {
    parts.push(
      `${impact.endpointIntentNames.length} Endpoint ${plural(impact.endpointIntentNames.length, "intent", "intents")}`,
    );
  }
  if (impact.pendingCleanupCount > 0) {
    parts.push(
      `${impact.pendingCleanupCount} pending ${plural(impact.pendingCleanupCount, "cleanup", "cleanups")}`,
    );
  }
  return `${base}; ${closeConnections ? "will close" : "affects"} ${parts.join(", ")} before provider destroy`;
}

function plural(count: number, singular: string, pluralValue: string): string {
  return count === 1 ? singular : pluralValue;
}
