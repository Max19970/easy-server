import {
  normalizedError,
  type OperationContext,
} from "@easyai101/easyserver-plugin-sdk";

export type HostOperationKind = "read" | "mutation";

export interface HostOperationContext extends OperationContext {
  markMutationDispatched(): void;
}

export const DEFAULT_HOST_OPERATION_TIMEOUT_MS = 60_000;

const retrySafeMutationFailures = new WeakSet<object>();

export function isRetrySafeHostMutationFailure(error: unknown): boolean {
  return isObject(error) && retrySafeMutationFailures.has(error);
}

export class HostOperationRunner {
  constructor(
    private readonly timeoutMs = DEFAULT_HOST_OPERATION_TIMEOUT_MS,
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new TypeError("timeoutMs must be a positive integer");
    }
  }

  async run<T>(
    kind: HostOperationKind,
    label: string,
    context: OperationContext,
    invoke: (context: HostOperationContext) => Promise<T>,
  ): Promise<T> {
    if (context.signal.aborted) {
      const error = normalizedError("cancelled", `${label} was cancelled before dispatch`);
      certifyRetrySafeMutationFailure(kind, error);
      throw error;
    }

    const timeout = new AbortController();
    const signal = AbortSignal.any([context.signal, timeout.signal]);
    let mutationDispatched = false;
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new HostOperationAbort());
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);

    const invocation = Promise.resolve().then(async () => {
      if (signal.aborted) {
        throw new HostOperationAbort();
      }
      return invoke({
        signal,
        markMutationDispatched() {
          if (kind === "mutation") {
            mutationDispatched = true;
          }
        },
      });
    });

    try {
      return await Promise.race([invocation, aborted]);
    } catch (error) {
      if (!(error instanceof HostOperationAbort)) {
        if (mutationDispatched) {
          revokeRetrySafeMutationFailure(kind, error);
        } else {
          certifyRetrySafeMutationFailure(kind, error);
        }
        throw error;
      }

      if (kind === "mutation" && mutationDispatched) {
        throw normalizedError(
          "outcome-unknown",
          `${label} outcome is unknown after possible dispatch`,
        );
      }

      if (timeout.signal.aborted && !context.signal.aborted) {
        const failure = normalizedError(
          "timeout",
          `${label} timed out${kind === "mutation" ? " before dispatch" : ""}`,
        );
        certifyRetrySafeMutationFailure(kind, failure);
        throw failure;
      }

      const failure = normalizedError(
        "cancelled",
        `${label} was cancelled${kind === "mutation" ? " before dispatch" : ""}`,
      );
      certifyRetrySafeMutationFailure(kind, failure);
      throw failure;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}

class HostOperationAbort extends Error {}

function certifyRetrySafeMutationFailure(
  kind: HostOperationKind,
  error: unknown,
): void {
  if (kind === "mutation" && isObject(error)) {
    retrySafeMutationFailures.add(error);
  }
}

function revokeRetrySafeMutationFailure(
  kind: HostOperationKind,
  error: unknown,
): void {
  if (kind === "mutation" && isObject(error)) {
    retrySafeMutationFailures.delete(error);
  }
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
