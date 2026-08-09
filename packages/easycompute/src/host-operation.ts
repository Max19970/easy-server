import {
  normalizedError,
  type OperationContext,
} from "@easycompute/plugin-sdk";

export type HostOperationKind = "read" | "mutation";

export const DEFAULT_HOST_OPERATION_TIMEOUT_MS = 60_000;

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
    invoke: (context: OperationContext) => Promise<T>,
  ): Promise<T> {
    if (context.signal.aborted) {
      throw normalizedError("cancelled", `${label} was cancelled before dispatch`);
    }

    const timeout = new AbortController();
    const signal = AbortSignal.any([context.signal, timeout.signal]);
    let dispatched = false;
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
      dispatched = true;
      return invoke({ signal });
    });

    try {
      return await Promise.race([invocation, aborted]);
    } catch (error) {
      if (!(error instanceof HostOperationAbort)) {
        throw error;
      }

      if (kind === "mutation" && dispatched) {
        throw normalizedError(
          "outcome-unknown",
          `${label} outcome is unknown after possible dispatch`,
        );
      }

      if (timeout.signal.aborted && !context.signal.aborted) {
        throw normalizedError(
          "timeout",
          `${label} timed out${dispatched ? "" : " before dispatch"}`,
        );
      }

      throw normalizedError(
        "cancelled",
        `${label} was cancelled${dispatched ? "" : " before dispatch"}`,
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}

class HostOperationAbort extends Error {}
