import {
  normalizedError,
  type AvailableAction,
  type InstanceState,
  type OperationContext,
} from "@easyai101/easyserver-plugin-sdk";
import type {
  ComputeManager,
  InstanceWaitTarget,
} from "./compute-manager.js";
import {
  createHostRuntime,
  resolveHostRuntimePaths,
  type HostRuntimePaths,
} from "./host-runtime.js";
import type {
  InstanceDestroyConfirmationDetails,
  InstanceOperations,
} from "./instance-operations.js";
import type { MutationConfirmationPrompt } from "./mutation-safety.js";

export type TuiInstanceMutation =
  | {
      readonly kind: "adopt";
      readonly instanceId: string;
    }
  | {
      readonly kind: "action";
      readonly instanceId: string;
      readonly action: AvailableAction;
    };

export type TuiInstanceMutationProgress = "dispatching" | "observing";

export interface TuiInstanceMutationInteraction {
  progress?(progress: TuiInstanceMutationProgress): void;
  warning?(message: string): void;
  confirm?(
    prompt: MutationConfirmationPrompt,
    details: InstanceDestroyConfirmationDetails,
    context: OperationContext,
  ): Promise<boolean>;
}

export interface TuiInstanceMutationResult {
  readonly observedState: InstanceState | "absent";
}

export type TuiInstanceMutationRunner = (
  mutation: TuiInstanceMutation,
  interaction?: TuiInstanceMutationInteraction,
) => Promise<TuiInstanceMutationResult>;

interface TuiInstanceRuntime {
  readonly instanceOperations: Pick<InstanceOperations, "adopt" | "perform">;
  readonly computeManager: Pick<ComputeManager, "inspectInstance" | "waitForInstance">;
}

export interface TuiInstanceMutationRunnerDependencies {
  readonly waitTimeoutMs?: number;
  readonly createRuntime?: () => Promise<TuiInstanceRuntime>;
}

export function createDefaultTuiInstanceMutationRunner(
  paths: HostRuntimePaths = resolveHostRuntimePaths(),
  dependencies: TuiInstanceMutationRunnerDependencies = {},
): TuiInstanceMutationRunner {
  const waitTimeoutMs = dependencies.waitTimeoutMs ?? 60_000;
  if (!Number.isInteger(waitTimeoutMs) || waitTimeoutMs < 1) {
    throw new TypeError("TUI instance waitTimeoutMs must be a positive integer");
  }
  const createRuntime =
    dependencies.createRuntime ?? (() => createHostRuntime({ paths }));

  return async (mutation, interaction = {}) => {
    const runtime = await createRuntime();
    const context: OperationContext = { signal: new AbortController().signal };

    interaction.progress?.("dispatching");
    if (mutation.kind === "adopt") {
      await runtime.instanceOperations.adopt(mutation.instanceId);
      interaction.progress?.("observing");
      const instance = await runtime.computeManager.inspectInstance(
        mutation.instanceId,
        context,
      );
      if (instance === undefined) {
        throw normalizedError(
          "not-found",
          `Compute Instance ${mutation.instanceId} disappeared after adoption`,
        );
      }
      return { observedState: instance.state };
    }

    await runtime.instanceOperations.perform({
      instanceId: mutation.instanceId,
      action: mutation.action,
      context,
      ...(mutation.action === "instance.destroy"
        ? {
            closeConnections: true,
            interaction: {
              ...(interaction.warning === undefined
                ? {}
                : { warning: interaction.warning }),
              ...(interaction.confirm === undefined
                ? {}
                : { confirm: interaction.confirm }),
            },
          }
        : {}),
    });

    interaction.progress?.("observing");
    const result = await runtime.computeManager.waitForInstance(
      mutation.instanceId,
      waitTarget(mutation.action),
      { timeoutMs: waitTimeoutMs },
      context,
    );
    return { observedState: result.observedState };
  };
}

function waitTarget(action: AvailableAction): InstanceWaitTarget {
  if (action === "instance.stop") {
    return "stopped";
  }
  if (action === "instance.destroy") {
    return "absent";
  }
  return "running";
}
