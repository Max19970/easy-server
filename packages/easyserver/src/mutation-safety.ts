import {
  normalizedError,
  type OperationContext,
  type ProviderMutationRisk,
} from "@easyai101/easyserver-plugin-sdk";

export interface MutationConfirmationPrompt {
  readonly summary: string;
  readonly risks: readonly ProviderMutationRisk[];
  readonly consequence: string;
}

export interface MutationSafetyOptions {
  readonly assumeYes: boolean;
  readonly interactive: boolean;
  readonly confirm?: (
    prompt: MutationConfirmationPrompt,
    context: OperationContext,
  ) => Promise<boolean>;
}

export async function requireMutationConfirmation(
  summary: string,
  risks: readonly ProviderMutationRisk[],
  context: OperationContext,
  options: MutationSafetyOptions,
): Promise<void> {
  if (risks.length === 0 || options.assumeYes) {
    return;
  }
  if (context.signal.aborted) {
    throw normalizedError("cancelled", `${summary} was cancelled before dispatch`);
  }
  if (!options.interactive) {
    throw normalizedError(
      "conflict",
      `${summary} requires explicit --yes because it is ${risks.join(" and ")}`,
    );
  }
  if (options.confirm === undefined) {
    throw new TypeError("interactive mutation safety requires a confirmation handler");
  }

  const accepted = await options.confirm(
    {
      summary,
      risks,
      consequence: mutationConsequence(risks),
    },
    context,
  );
  if (!accepted) {
    throw normalizedError("cancelled", `${summary} was cancelled before dispatch`);
  }
}

function mutationConsequence(risks: readonly ProviderMutationRisk[]): string {
  const consequences: string[] = [];
  if (risks.includes("billable")) {
    consequences.push("may create or increase provider charges");
  }
  if (risks.includes("destructive")) {
    consequences.push("may irreversibly delete or release a provider resource");
  }
  return consequences.join("; ");
}
