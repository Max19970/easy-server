import {
  isNormalizedError,
  type HostTrustRequiredError,
} from "@easyai101/easyserver-plugin-sdk";
import {
  isRetrySafeHostMutationFailure,
  type HostOperationKind,
} from "./host-operation.js";
import type { MutationConfirmationPrompt } from "./mutation-safety.js";
import type { PersistentConnectionSession } from "./local-daemon.js";
import type { ProviderCommandExecutionResult } from "./provider-command-runner.js";
import type { ProviderTranscriptEvent } from "./provider-feature-operations.js";
import { escapeTerminalText } from "./terminal-text.js";

export type TuiOperationPhase =
  | "working"
  | "awaiting-confirmation"
  | "completed"
  | "failed"
  | "cancelled"
  | "outcome-unknown"
  | "reconciliation-pending"
  | "reconciliation-failed";

export type TuiOperationTone = "info" | "success" | "warning" | "danger";

export type TuiOperationActivity =
  | "loading"
  | "waiting-provider"
  | "verifying-state"
  | "requested"
  | "dispatching"
  | "observing";

export type TuiOperationActionKind =
  | "cancel"
  | "confirm"
  | "decline"
  | "trust"
  | "retry"
  | "observe"
  | "refresh"
  | "dismiss";

export interface TuiOperationAction {
  readonly kind: TuiOperationActionKind;
  readonly label: string;
}

export type TuiOperationInteraction =
  | {
      readonly kind: "mutation-confirmation";
      readonly summary: string;
      readonly risks: readonly string[];
      readonly consequence: string;
      readonly target: string;
      readonly affectedResources: readonly string[];
    }
  | {
      readonly kind: "host-trust";
      readonly host: string;
      readonly port: number;
      readonly keyType: string;
      readonly fingerprint: string;
    };

export interface TuiProviderTranscriptLine {
  readonly stream: ProviderTranscriptEvent["stream"];
  readonly text: string;
}

const presentationTypeBrand: unique symbol = Symbol("EasyServerTuiOperationPresentation");
const trustedPresentations = new WeakSet<object>();
const DEFAULT_PROVIDER_TRANSCRIPT_CHARACTERS = 4_096;
const MAX_PRESENTATION_TEXT_CHARACTERS = 4_096;
const MAX_PRESENTATION_TITLE_CHARACTERS = 512;
const MAX_ACTION_LABEL_CHARACTERS = 128;

export interface TuiOperationPresentation {
  readonly [presentationTypeBrand]: true;
  readonly phase: TuiOperationPhase;
  readonly activity?: TuiOperationActivity;
  readonly tone: TuiOperationTone;
  readonly title: string;
  readonly detail?: string;
  readonly actions: readonly TuiOperationAction[];
  readonly interaction?: TuiOperationInteraction;
  readonly providerOutput?: readonly TuiProviderTranscriptLine[];
}

type TuiOperationPresentationData = Omit<
  TuiOperationPresentation,
  typeof presentationTypeBrand
>;

export interface PresentWorkingOperationInput {
  readonly title: string;
  readonly activity: TuiOperationActivity;
  readonly detail?: string;
  readonly cancellable?: boolean;
}

export interface PresentOperationErrorInput {
  readonly title: string;
  readonly operation: HostOperationKind;
  readonly error: unknown;
}

export interface PresentCompletedOperationInput {
  readonly title: string;
  readonly detail?: string;
}

export interface MutationConfirmationContext {
  readonly target: string;
  readonly affectedResources: readonly string[];
}

const DISMISS_ACTION: TuiOperationAction = {
  kind: "dismiss",
  label: "Dismiss",
};

const OBSERVE_ACTION: TuiOperationAction = {
  kind: "observe",
  label: "Observe state",
};

const REFRESH_ACTION: TuiOperationAction = {
  kind: "refresh",
  label: "Refresh",
};

const RETRY_ACTION: TuiOperationAction = {
  kind: "retry",
  label: "Retry",
};

export function isTuiOperationPresentation(
  value: unknown,
): value is TuiOperationPresentation {
  return isObject(value) && trustedPresentations.has(value);
}

export function assertTuiOperationPresentation(
  value: unknown,
): asserts value is TuiOperationPresentation {
  if (!isTuiOperationPresentation(value)) {
    throw new TypeError(
      "TUI operation presentations must be created by EasyServer presentation helpers",
    );
  }
}

export function presentWorkingOperation(
  input: PresentWorkingOperationInput,
): TuiOperationPresentation {
  return createPresentation({
    phase: "working",
    activity: input.activity,
    tone: "info",
    title: input.title,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
    actions: input.cancellable
      ? [{ kind: "cancel", label: "Cancel" }]
      : [],
  });
}

export function presentCompletedOperation(
  input: PresentCompletedOperationInput,
): TuiOperationPresentation {
  return createPresentation({
    phase: "completed",
    tone: "success",
    title: input.title,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
    actions: [DISMISS_ACTION],
  });
}

export function presentOperationError(
  input: PresentOperationErrorInput,
): TuiOperationPresentation {
  const normalized = isNormalizedError(input.error) ? input.error : undefined;
  const message =
    normalized?.message ??
    (input.error instanceof Error ? input.error.message : "Operation failed");

  if (normalized?.code === "outcome-unknown") {
    return createPresentation({
      phase: "outcome-unknown",
      tone: "warning",
      title: `${input.title}: outcome unknown`,
      detail: `${message}. The remote mutation may have been dispatched; do not repeat it blindly. Observe or refresh remote state instead.`,
      actions: [OBSERVE_ACTION, REFRESH_ACTION, DISMISS_ACTION],
    });
  }

  const definitelyCancelled = normalized?.code === "cancelled";
  const retryAllowed =
    input.operation === "read" ||
    (input.operation === "mutation" &&
      isRetrySafeHostMutationFailure(input.error));

  return createPresentation({
    phase: definitelyCancelled ? "cancelled" : "failed",
    tone: definitelyCancelled ? "info" : "danger",
    title: definitelyCancelled
      ? `${input.title}: cancelled`
      : `${input.title}: failed`,
    detail: message,
    actions: retryAllowed
      ? [RETRY_ACTION, DISMISS_ACTION]
      : [DISMISS_ACTION],
  });
}

export function presentProviderExecution(
  title: string,
  execution: ProviderCommandExecutionResult,
): TuiOperationPresentation {
  if (
    execution.operation === "mutation" &&
    execution.mutationOutcome === "succeeded"
  ) {
    if (execution.handoff.status === "failed") {
      return createPresentation({
        phase: "reconciliation-failed",
        tone: "warning",
        title: `${title} succeeded; reconciliation needs attention`,
        detail: reconciliationFailureDetail(execution.handoff.failure),
        actions: [OBSERVE_ACTION, REFRESH_ACTION, DISMISS_ACTION],
      });
    }

    if (execution.handoff.status === "partial") {
      return createPresentation({
        phase: "reconciliation-pending",
        tone: "warning",
        title: `${title} succeeded; some resulting resources are not resolved yet`,
        detail:
          "The mutation is confirmed. Observe or refresh inventory to finish the handoff; do not repeat the mutation just to obtain local resource identities.",
        actions: [OBSERVE_ACTION, REFRESH_ACTION, DISMISS_ACTION],
      });
    }
  }

  return createPresentation({
    phase: "completed",
    tone: "success",
    title: `${title} completed`,
    actions: [DISMISS_ACTION],
  });
}

export function presentMutationConfirmation(
  prompt: MutationConfirmationPrompt,
  context: MutationConfirmationContext,
): TuiOperationPresentation {
  return createPresentation({
    phase: "awaiting-confirmation",
    tone: "warning",
    title: "Confirmation required",
    detail: prompt.summary,
    interaction: {
      kind: "mutation-confirmation",
      summary: prompt.summary,
      risks: [...prompt.risks],
      consequence: prompt.consequence,
      target: context.target,
      affectedResources: [...context.affectedResources],
    },
    actions: [
      { kind: "confirm", label: "Confirm" },
      { kind: "decline", label: "Cancel" },
    ],
  });
}

export function presentHostTrustRequest(
  trust: HostTrustRequiredError,
): TuiOperationPresentation {
  return createPresentation({
    phase: "awaiting-confirmation",
    tone: "warning",
    title: "SSH host trust required",
    detail: `Verify the exact fingerprint before trusting ${trust.host}:${trust.port}.`,
    interaction: {
      kind: "host-trust",
      host: trust.host,
      port: trust.port,
      keyType: trust.keyType,
      fingerprint: trust.fingerprint,
    },
    actions: [
      { kind: "trust", label: "Trust this fingerprint" },
      { kind: "decline", label: "Decline" },
    ],
  });
}

export function presentSessionState(
  session: PersistentConnectionSession,
): TuiOperationPresentation {
  if (session.state === "failed") {
    return createPresentation({
      phase: "failed",
      tone: "danger",
      title: `Session ${session.id} needs attention`,
      detail: session.failure.message,
      actions: [DISMISS_ACTION],
    });
  }

  if (session.state === "closing") {
    return createPresentation({
      phase: "working",
      activity: "verifying-state",
      tone: "info",
      title: `Closing session ${session.id}`,
      actions: [],
    });
  }

  return createPresentation({
    phase: "completed",
    tone: "success",
    title: `Session ${session.id} is live`,
    actions: [DISMISS_ACTION],
  });
}

export function appendOperationProviderTranscript(
  operation: TuiOperationPresentation,
  event: ProviderTranscriptEvent,
  maxCharacters = DEFAULT_PROVIDER_TRANSCRIPT_CHARACTERS,
): TuiOperationPresentation {
  assertTuiOperationPresentation(operation);
  return createPresentation({
    phase: operation.phase,
    ...(operation.activity === undefined ? {} : { activity: operation.activity }),
    tone: operation.tone,
    title: operation.title,
    ...(operation.detail === undefined ? {} : { detail: operation.detail }),
    actions: operation.actions,
    ...(operation.interaction === undefined
      ? {}
      : { interaction: operation.interaction }),
    providerOutput: appendProviderTranscript(
      operation.providerOutput ?? [],
      event,
      maxCharacters,
    ),
  });
}

export const withProviderTranscript = appendOperationProviderTranscript;

export function appendProviderTranscript(
  current: readonly TuiProviderTranscriptLine[],
  event: ProviderTranscriptEvent,
  maxCharacters = DEFAULT_PROVIDER_TRANSCRIPT_CHARACTERS,
): readonly TuiProviderTranscriptLine[] {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
    throw new TypeError("maxCharacters must be a positive integer");
  }

  return boundProviderOutput(
    [
      ...current,
      {
        stream: event.stream,
        text: event.text,
      },
    ],
    maxCharacters,
  );
}

function createPresentation(
  data: TuiOperationPresentationData,
): TuiOperationPresentation {
  assertActionsMatchPresentation(data);

  const actions = Object.freeze(
    data.actions.map((action) =>
      Object.freeze({
        kind: action.kind,
        label: safeText(action.label, MAX_ACTION_LABEL_CHARACTERS),
      }),
    ),
  );
  const interaction = sanitizeInteraction(data.interaction);
  const providerOutput =
    data.providerOutput === undefined
      ? undefined
      : boundProviderOutput(
          data.providerOutput,
          DEFAULT_PROVIDER_TRANSCRIPT_CHARACTERS,
        );

  const result = {
    phase: data.phase,
    ...(data.activity === undefined ? {} : { activity: data.activity }),
    tone: data.tone,
    title: safeText(data.title, MAX_PRESENTATION_TITLE_CHARACTERS),
    ...(data.detail === undefined
      ? {}
      : { detail: safeText(data.detail, MAX_PRESENTATION_TEXT_CHARACTERS) }),
    actions,
    ...(interaction === undefined ? {} : { interaction }),
    ...(providerOutput === undefined ? {} : { providerOutput }),
  } as TuiOperationPresentation;

  Object.defineProperty(result, presentationTypeBrand, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  trustedPresentations.add(result);
  return Object.freeze(result);
}

function sanitizeInteraction(
  interaction: TuiOperationInteraction | undefined,
): TuiOperationInteraction | undefined {
  if (interaction === undefined) {
    return undefined;
  }
  if (interaction.kind === "mutation-confirmation") {
    return Object.freeze({
      kind: interaction.kind,
      summary: safeText(interaction.summary, MAX_PRESENTATION_TEXT_CHARACTERS),
      risks: Object.freeze(
        interaction.risks.map((risk) => safeText(risk, MAX_ACTION_LABEL_CHARACTERS)),
      ),
      consequence: safeText(interaction.consequence, MAX_PRESENTATION_TEXT_CHARACTERS),
      target: safeText(interaction.target, MAX_PRESENTATION_TEXT_CHARACTERS),
      affectedResources: Object.freeze(
        interaction.affectedResources.map((resource) =>
          safeText(resource, MAX_PRESENTATION_TEXT_CHARACTERS),
        ),
      ),
    });
  }
  return Object.freeze({
    kind: interaction.kind,
    host: safeText(interaction.host, MAX_PRESENTATION_TEXT_CHARACTERS),
    port: interaction.port,
    keyType: safeText(interaction.keyType, MAX_PRESENTATION_TEXT_CHARACTERS),
    fingerprint: safeText(interaction.fingerprint, MAX_PRESENTATION_TEXT_CHARACTERS),
  });
}

function boundProviderOutput(
  lines: readonly TuiProviderTranscriptLine[],
  maxCharacters: number,
): readonly TuiProviderTranscriptLine[] {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
    throw new TypeError("maxCharacters must be a positive integer");
  }

  const next = lines.map((line) => ({
    stream: line.stream,
    text: escapeTerminalText(line.text),
  }));
  let total = next.reduce((sum, line) => sum + line.text.length, 0);

  while (next.length > 0 && total > maxCharacters) {
    const first = next[0]!;
    const overflow = total - maxCharacters;
    if (overflow >= first.text.length) {
      next.shift();
      total -= first.text.length;
      continue;
    }

    next[0] = {
      ...first,
      text: first.text.slice(overflow),
    };
    total = maxCharacters;
  }

  return Object.freeze(next.map((line) => Object.freeze(line)));
}

function assertActionsMatchPresentation(
  presentation: TuiOperationPresentationData,
): void {
  const awaitingConfirmation = presentation.phase === "awaiting-confirmation";
  if (awaitingConfirmation !== (presentation.interaction !== undefined)) {
    throw new TypeError(
      "TUI confirmation phase and interaction must be present together",
    );
  }

  const allowed = allowedActionKinds(presentation);
  for (const action of presentation.actions) {
    if (!allowed.has(action.kind)) {
      throw new TypeError(
        `TUI action ${action.kind} is not valid for ${presentation.phase}`,
      );
    }
  }
}

function allowedActionKinds(
  presentation: TuiOperationPresentationData,
): ReadonlySet<TuiOperationActionKind> {
  if (presentation.interaction?.kind === "mutation-confirmation") {
    return new Set(["confirm", "decline"]);
  }
  if (presentation.interaction?.kind === "host-trust") {
    return new Set(["trust", "decline"]);
  }
  if (presentation.phase === "working") {
    return new Set(["cancel"]);
  }
  if (
    presentation.phase === "outcome-unknown" ||
    presentation.phase === "reconciliation-pending" ||
    presentation.phase === "reconciliation-failed"
  ) {
    return new Set(["observe", "refresh", "dismiss"]);
  }
  if (
    presentation.phase === "failed" ||
    presentation.phase === "cancelled"
  ) {
    return new Set(["retry", "dismiss"]);
  }
  if (presentation.phase === "completed") {
    return new Set(["dismiss"]);
  }
  return new Set();
}

function reconciliationFailureDetail(
  failure:
    | "invalid-provider-result"
    | "management-intent-persist-failed"
    | "inventory-refresh-failed",
): string {
  if (failure === "invalid-provider-result") {
    return "The provider mutation succeeded, but its follow-up result could not be interpreted. Observe provider inventory instead of repeating the mutation.";
  }
  if (failure === "management-intent-persist-failed") {
    return "The provider mutation succeeded, but EasyServer could not persist management intent for the resulting resource. Observe provider inventory and recover the handoff without repeating the mutation.";
  }
  return "The provider mutation succeeded, but the follow-up inventory refresh failed. Observe or refresh inventory without repeating the mutation.";
}

function safeText(value: string, maxCharacters: number): string {
  const escaped = escapeTerminalText(value);
  return escaped.length <= maxCharacters
    ? escaped
    : escaped.slice(0, maxCharacters);
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
