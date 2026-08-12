import type {
  OperationContext,
  ProviderCliCommand,
  ProviderCliCommandHelp,
  ProviderCliOperation,
  ProviderMutationRisk,
} from "@easyai101/easyserver-plugin-sdk";
import {
  requireMutationConfirmation,
  type MutationConfirmationPrompt,
} from "./mutation-safety.js";
import {
  ProviderCommandRunner,
  type ProviderCommandExecutionResult,
  type ProviderInventoryRefresher,
} from "./provider-command-runner.js";
import {
  ProviderFeatureHost,
  type ProviderFeatureAdmission,
  type ProviderFeatureDescriptor,
} from "./provider-feature-host.js";

export interface ProviderFeatureCommandDescriptor {
  readonly name: string;
  readonly description: string;
  readonly operation: ProviderCliOperation;
  readonly risks: readonly ProviderMutationRisk[];
  readonly help?: ProviderCliCommandHelp;
}

export interface ProviderTranscriptEvent {
  readonly owner: "provider";
  readonly stream: "output" | "error";
  readonly text: string;
}

export interface ProviderFeatureInteraction {
  confirm?(
    prompt: MutationConfirmationPrompt,
    context: OperationContext,
  ): Promise<boolean>;
  transcript?(event: ProviderTranscriptEvent): void;
}

export interface ExecuteProviderFeatureCommandRequest {
  readonly providerId: string;
  readonly featureId: string;
  readonly commandName: string;
  readonly args: readonly string[];
  readonly context: OperationContext;
  readonly assumeYes?: boolean;
  readonly interaction?: ProviderFeatureInteraction;
}

export class ProviderFeatureOperations {
  constructor(
    private readonly featureHost: ProviderFeatureHost,
    private readonly inventory: ProviderInventoryRefresher,
    private readonly runner = new ProviderCommandRunner(),
  ) {}

  listFeatures(providerId?: string): readonly ProviderFeatureDescriptor[] {
    const features = this.featureHost.listFeatures();
    return providerId === undefined
      ? features
      : features.filter((feature) => feature.providerId === providerId);
  }

  listCommands(
    providerId: string,
    featureId: string,
  ): readonly ProviderFeatureCommandDescriptor[] {
    const admission = this.#acquire(providerId, featureId);
    try {
      return (admission.feature.cli?.commands ?? []).map(toCommandDescriptor);
    } finally {
      admission.release();
    }
  }

  async execute(
    request: ExecuteProviderFeatureCommandRequest,
  ): Promise<ProviderCommandExecutionResult> {
    const admission = this.#acquire(request.providerId, request.featureId);
    try {
      const command = admission.feature.cli?.commands.find(
        (candidate) => candidate.name === request.commandName,
      );
      if (command === undefined) {
        throw new Error(
          `Provider command not found: ${request.providerId}/${request.featureId}/${request.commandName}`,
        );
      }

      const risks = command.risks ?? [];
      const interaction = request.interaction;
      await requireMutationConfirmation(
        `Provider command ${request.providerId}/${request.featureId}/${request.commandName} (provider=${request.providerId})`,
        risks,
        request.context,
        {
          assumeYes: request.assumeYes === true,
          interactive: interaction?.confirm !== undefined,
          ...(interaction?.confirm === undefined
            ? {}
            : { confirm: interaction.confirm.bind(interaction) }),
        },
      );

      return await this.runner.run({
        providerId: request.providerId,
        featureId: request.featureId,
        command,
        args: request.args,
        admission,
        inventory: this.inventory,
        context: request.context,
        write: (text) =>
          interaction?.transcript?.({ owner: "provider", stream: "output", text }),
        writeError: (text) =>
          interaction?.transcript?.({ owner: "provider", stream: "error", text }),
      });
    } finally {
      admission.release();
    }
  }

  #acquire(providerId: string, featureId: string): ProviderFeatureAdmission {
    const admission = this.featureHost.acquire(providerId, featureId);
    if (admission === undefined) {
      throw new Error(`Provider Feature not found: ${providerId}/${featureId}`);
    }
    return admission;
  }
}

function toCommandDescriptor(
  command: ProviderCliCommand,
): ProviderFeatureCommandDescriptor {
  return {
    name: command.name,
    description: command.description,
    operation: command.operation,
    risks: command.risks ?? [],
    ...(command.help === undefined ? {} : { help: command.help }),
  };
}
