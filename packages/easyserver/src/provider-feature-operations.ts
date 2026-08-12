import {
  parseProviderInteractiveSession,
  parseProviderInteractiveTransition,
  type OperationContext,
  type ProviderCliCommand,
  type ProviderCliCommandHelp,
  type ProviderCliOperation,
  type ProviderInteractiveEvent,
  type ProviderInteractiveScreen,
  type ProviderInteractiveSession as ProviderOwnedInteractiveSession,
  type ProviderMutationRisk,
} from "@easyai101/easyserver-plugin-sdk";
import { HostOperationRunner } from "./host-operation.js";
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

export type ProviderFeatureCommandPresentation =
  | {
      readonly kind: "interactive-flow";
      readonly flowId: string;
    }
  | { readonly kind: "cli-fallback" };

export interface ProviderFeatureCommandDescriptor {
  readonly name: string;
  readonly description: string;
  readonly operation: ProviderCliOperation;
  readonly risks: readonly ProviderMutationRisk[];
  readonly presentation: ProviderFeatureCommandPresentation;
  readonly help?: ProviderCliCommandHelp;
}

export interface ProviderInteractiveFlowDescriptor {
  readonly id: string;
  readonly commandName: string;
  readonly command: ProviderFeatureCommandDescriptor;
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

export interface OpenProviderInteractiveFlowRequest {
  readonly providerId: string;
  readonly featureId: string;
  readonly flowId: string;
  readonly context: OperationContext;
}

export type ProviderInteractiveSessionResult =
  | {
      readonly kind: "screen";
      readonly screen: ProviderInteractiveScreen;
    }
  | {
      readonly kind: "executed";
      readonly execution: ProviderCommandExecutionResult;
    };

export interface ProviderInteractiveSessionHandle {
  readonly descriptor: ProviderInteractiveFlowDescriptor;
  readonly screen: ProviderInteractiveScreen;
  dispatch(
    event: ProviderInteractiveEvent,
    context: OperationContext,
    interaction?: ProviderFeatureInteraction,
  ): Promise<ProviderInteractiveSessionResult>;
  close(): void;
}

export class ProviderFeatureOperations {
  constructor(
    private readonly featureHost: ProviderFeatureHost,
    private readonly inventory: ProviderInventoryRefresher,
    private readonly runner = new ProviderCommandRunner(),
    private readonly interactions = new HostOperationRunner(),
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
      return (admission.feature.cli?.commands ?? []).map((command) =>
        toCommandDescriptor(
          command,
          admission.feature.interactive?.flows.find(
            (flow) => flow.commandName === command.name,
          )?.id,
        ),
      );
    } finally {
      admission.release();
    }
  }

  listInteractiveFlows(
    providerId: string,
    featureId: string,
  ): readonly ProviderInteractiveFlowDescriptor[] {
    const admission = this.#acquire(providerId, featureId);
    try {
      return (admission.feature.interactive?.flows ?? []).map((flow) => {
        const command = findCommand(admission, providerId, featureId, flow.commandName);
        return {
          id: flow.id,
          commandName: flow.commandName,
          command: toCommandDescriptor(command, flow.id),
        };
      });
    } finally {
      admission.release();
    }
  }

  async openInteractiveFlow(
    request: OpenProviderInteractiveFlowRequest,
  ): Promise<ProviderInteractiveSessionHandle> {
    const admission = this.#acquire(request.providerId, request.featureId);
    try {
      const flow = admission.feature.interactive?.flows.find(
        (candidate) => candidate.id === request.flowId,
      );
      if (flow === undefined) {
        throw new Error(
          `Provider interactive flow not found: ${request.providerId}/${request.featureId}/${request.flowId}`,
        );
      }
      const command = findCommand(
        admission,
        request.providerId,
        request.featureId,
        flow.commandName,
      );
      const providerSession = parseProviderInteractiveSession(
        await this.interactions.run(
          "read",
          `Provider interactive flow ${request.providerId}/${request.featureId}/${flow.id} open`,
          request.context,
          (operationContext) =>
            flow.open({
              signal: operationContext.signal,
              resolveCredential: (name) =>
                admission.resolveCredential(name, operationContext.signal),
            }),
        ),
      );
      const descriptor: ProviderInteractiveFlowDescriptor = {
        id: flow.id,
        commandName: flow.commandName,
        command: toCommandDescriptor(command, flow.id),
      };
      return new ProviderInteractiveSessionHandleImpl({
        providerId: request.providerId,
        featureId: request.featureId,
        descriptor,
        admission,
        providerSession,
        interactions: this.interactions,
        execute: (args, context, interaction) =>
          this.#executeWithAdmission({
            providerId: request.providerId,
            featureId: request.featureId,
            command,
            args,
            context,
            admission,
            interaction,
          }),
      });
    } catch (error) {
      admission.release();
      throw error;
    }
  }

  async execute(
    request: ExecuteProviderFeatureCommandRequest,
  ): Promise<ProviderCommandExecutionResult> {
    const admission = this.#acquire(request.providerId, request.featureId);
    try {
      const command = findCommand(
        admission,
        request.providerId,
        request.featureId,
        request.commandName,
      );
      return await this.#executeWithAdmission({
        providerId: request.providerId,
        featureId: request.featureId,
        command,
        args: request.args,
        context: request.context,
        admission,
        assumeYes: request.assumeYes,
        interaction: request.interaction,
      });
    } finally {
      admission.release();
    }
  }

  async #executeWithAdmission(input: {
    readonly providerId: string;
    readonly featureId: string;
    readonly command: ProviderCliCommand;
    readonly args: readonly string[];
    readonly context: OperationContext;
    readonly admission: ProviderFeatureAdmission;
    readonly assumeYes?: boolean;
    readonly interaction?: ProviderFeatureInteraction;
  }): Promise<ProviderCommandExecutionResult> {
    const risks = input.command.risks ?? [];
    const interaction = input.interaction;
    await requireMutationConfirmation(
      `Provider command ${input.providerId}/${input.featureId}/${input.command.name} (provider=${input.providerId})`,
      risks,
      input.context,
      {
        assumeYes: input.assumeYes === true,
        interactive: interaction?.confirm !== undefined,
        ...(interaction?.confirm === undefined
          ? {}
          : { confirm: interaction.confirm.bind(interaction) }),
      },
    );

    return this.runner.run({
      providerId: input.providerId,
      featureId: input.featureId,
      command: input.command,
      args: input.args,
      admission: input.admission,
      inventory: this.inventory,
      context: input.context,
      write: (text) =>
        interaction?.transcript?.({ owner: "provider", stream: "output", text }),
      writeError: (text) =>
        interaction?.transcript?.({ owner: "provider", stream: "error", text }),
    });
  }

  #acquire(providerId: string, featureId: string): ProviderFeatureAdmission {
    const admission = this.featureHost.acquire(providerId, featureId);
    if (admission === undefined) {
      throw new Error(`Provider Feature not found: ${providerId}/${featureId}`);
    }
    return admission;
  }
}

interface InteractiveHandleOptions {
  readonly providerId: string;
  readonly featureId: string;
  readonly descriptor: ProviderInteractiveFlowDescriptor;
  readonly admission: ProviderFeatureAdmission;
  readonly providerSession: ProviderOwnedInteractiveSession;
  readonly interactions: HostOperationRunner;
  readonly execute: (
    args: readonly string[],
    context: OperationContext,
    interaction?: ProviderFeatureInteraction,
  ) => Promise<ProviderCommandExecutionResult>;
}

class ProviderInteractiveSessionHandleImpl
  implements ProviderInteractiveSessionHandle
{
  readonly descriptor: ProviderInteractiveFlowDescriptor;
  #screen: ProviderInteractiveScreen;
  #closed = false;

  constructor(private readonly options: InteractiveHandleOptions) {
    this.descriptor = options.descriptor;
    this.#screen = options.providerSession.initialScreen;
  }

  get screen(): ProviderInteractiveScreen {
    return this.#screen;
  }

  async dispatch(
    event: ProviderInteractiveEvent,
    context: OperationContext,
    interaction?: ProviderFeatureInteraction,
  ): Promise<ProviderInteractiveSessionResult> {
    this.#assertOpen();
    const transition = parseProviderInteractiveTransition(
      await this.options.interactions.run(
        "read",
        `Provider interactive flow ${this.options.providerId}/${this.options.featureId}/${this.descriptor.id} transition`,
        context,
        (operationContext) =>
          this.options.providerSession.dispatch(event, {
            signal: operationContext.signal,
            resolveCredential: (name) =>
              this.options.admission.resolveCredential(
                name,
                operationContext.signal,
              ),
          }),
      ),
    );

    if (transition.kind === "screen") {
      this.#screen = transition.screen;
      return transition;
    }

    try {
      return {
        kind: "executed",
        execution: await this.options.execute(
          transition.args,
          context,
          interaction,
        ),
      };
    } finally {
      this.close();
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.options.admission.release();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("Provider interactive flow session is closed");
    }
  }
}

function findCommand(
  admission: ProviderFeatureAdmission,
  providerId: string,
  featureId: string,
  commandName: string,
): ProviderCliCommand {
  const command = admission.feature.cli?.commands.find(
    (candidate) => candidate.name === commandName,
  );
  if (command === undefined) {
    throw new Error(
      `Provider command not found: ${providerId}/${featureId}/${commandName}`,
    );
  }
  return command;
}

function toCommandDescriptor(
  command: ProviderCliCommand,
  interactiveFlowId?: string,
): ProviderFeatureCommandDescriptor {
  return {
    name: command.name,
    description: command.description,
    operation: command.operation,
    risks: command.risks ?? [],
    presentation:
      interactiveFlowId === undefined
        ? { kind: "cli-fallback" }
        : { kind: "interactive-flow", flowId: interactiveFlowId },
    ...(command.help === undefined ? {} : { help: command.help }),
  };
}
