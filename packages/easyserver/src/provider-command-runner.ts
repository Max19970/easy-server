import {
  isNormalizedError,
  parseProviderCliCommandResult,
  type OperationContext,
  type ProviderCliCommand,
  type ProviderCliCommandResult,
  type ProviderCliOperation,
} from "@easyai101/easyserver-plugin-sdk";
import type { ComputeInstance } from "./compute-manager.js";
import { HostOperationRunner } from "./host-operation.js";
import type { ProviderFeatureAdmission } from "./provider-feature-host.js";

export interface ProviderInventoryRefresher {
  refreshProvider(
    providerId: string,
    context: OperationContext,
  ): Promise<readonly ComputeInstance[]>;
}

export interface CanonicalInstanceHandoff {
  readonly providerExternalId: string;
  readonly instanceId: string;
}

export type ProviderCommandHandoff =
  | {
      readonly status: "not-requested";
      readonly affectedProviderExternalIds: readonly string[];
      readonly canonicalInstances: readonly CanonicalInstanceHandoff[];
      readonly unresolvedProviderExternalIds: readonly string[];
    }
  | {
      readonly status: "complete" | "partial";
      readonly affectedProviderExternalIds: readonly string[];
      readonly canonicalInstances: readonly CanonicalInstanceHandoff[];
      readonly unresolvedProviderExternalIds: readonly string[];
    }
  | {
      readonly status: "failed";
      readonly failure: "invalid-provider-result" | "inventory-refresh-failed";
      readonly affectedProviderExternalIds: readonly string[];
      readonly canonicalInstances: readonly CanonicalInstanceHandoff[];
      readonly unresolvedProviderExternalIds: readonly string[];
    };

export interface ProviderCommandExecutionResult {
  readonly operation: ProviderCliOperation;
  readonly mutationOutcome: "not-applicable" | "succeeded";
  readonly providerResult?: ProviderCliCommandResult;
  readonly handoff: ProviderCommandHandoff;
}

export interface ProviderCommandRunRequest {
  readonly providerId: string;
  readonly featureId: string;
  readonly command: ProviderCliCommand;
  readonly args: readonly string[];
  readonly admission: Pick<ProviderFeatureAdmission, "resolveCredential">;
  readonly inventory: ProviderInventoryRefresher;
  readonly context: OperationContext;
  write(text: string): void;
  writeError(text: string): void;
}

export class ProviderCommandRunner {
  constructor(private readonly operations = new HostOperationRunner()) {}

  async run(
    request: ProviderCommandRunRequest,
  ): Promise<ProviderCommandExecutionResult> {
    const { command } = request;
    let rawResult: void | ProviderCliCommandResult;

    try {
      rawResult = await this.operations.run(
        command.operation,
        `Provider Feature ${request.providerId}/${request.featureId}/${command.name}`,
        request.context,
        (operationContext) =>
          command.run(request.args, {
            signal: operationContext.signal,
            resolveCredential: (name) =>
              request.admission.resolveCredential(name, operationContext.signal),
            markMutationDispatched: operationContext.markMutationDispatched,
            write: request.write,
            writeError: request.writeError,
          }),
      );
    } catch (error) {
      if (
        command.operation === "mutation" &&
        isNormalizedError(error) &&
        error.code === "outcome-unknown"
      ) {
        await request.inventory
          .refreshProvider(request.providerId, {
            signal: new AbortController().signal,
          })
          .catch(() => undefined);
      }
      throw error;
    }

    let providerResult: ProviderCliCommandResult | undefined;
    try {
      providerResult = parseProviderCliCommandResult(rawResult);
    } catch (error) {
      if (command.operation !== "mutation") {
        throw error;
      }
      return {
        operation: command.operation,
        mutationOutcome: "succeeded",
        handoff: {
          status: "failed",
          failure: "invalid-provider-result",
          affectedProviderExternalIds: [],
          canonicalInstances: [],
          unresolvedProviderExternalIds: [],
        },
      };
    }

    const affectedProviderExternalIds =
      providerResult?.affectedProviderExternalIds ?? [];
    const refreshRequested =
      providerResult?.refreshProviderInventory === true ||
      affectedProviderExternalIds.length > 0;

    if (!refreshRequested) {
      return {
        operation: command.operation,
        mutationOutcome:
          command.operation === "mutation" ? "succeeded" : "not-applicable",
        ...(providerResult === undefined ? {} : { providerResult }),
        handoff: {
          status: "not-requested",
          affectedProviderExternalIds,
          canonicalInstances: [],
          unresolvedProviderExternalIds: affectedProviderExternalIds,
        },
      };
    }

    let instances: readonly ComputeInstance[];
    try {
      instances = await request.inventory.refreshProvider(request.providerId, {
        signal: new AbortController().signal,
      });
    } catch (error) {
      if (command.operation !== "mutation") {
        throw error;
      }
      return {
        operation: command.operation,
        mutationOutcome: "succeeded",
        ...(providerResult === undefined ? {} : { providerResult }),
        handoff: {
          status: "failed",
          failure: "inventory-refresh-failed",
          affectedProviderExternalIds,
          canonicalInstances: [],
          unresolvedProviderExternalIds: affectedProviderExternalIds,
        },
      };
    }

    const byExternalId = new Map(
      instances.map((instance) => [instance.providerExternalId, instance]),
    );
    const canonicalInstances: CanonicalInstanceHandoff[] = [];
    const unresolvedProviderExternalIds: string[] = [];
    for (const providerExternalId of affectedProviderExternalIds) {
      const instance = byExternalId.get(providerExternalId);
      if (instance === undefined) {
        unresolvedProviderExternalIds.push(providerExternalId);
      } else {
        canonicalInstances.push({
          providerExternalId,
          instanceId: instance.id,
        });
      }
    }

    return {
      operation: command.operation,
      mutationOutcome:
        command.operation === "mutation" ? "succeeded" : "not-applicable",
      ...(providerResult === undefined ? {} : { providerResult }),
      handoff: {
        status:
          unresolvedProviderExternalIds.length === 0 ? "complete" : "partial",
        affectedProviderExternalIds,
        canonicalInstances,
        unresolvedProviderExternalIds,
      },
    };
  }
}
