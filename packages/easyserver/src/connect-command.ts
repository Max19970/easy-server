import {
  isHostTrustRequiredError,
  normalizedError,
  type HostTrustRequiredError,
  type OperationContext,
} from "@easyai101/easyserver-plugin-sdk";
import {
  type ConnectionGateway,
  type Endpoint,
  type OpenEndpointResult,
} from "./connection-gateway.js";
import type { OpenSshAccessAdapter } from "./ssh-access-adapter.js";

export type ConfirmHostTrust = (
  trust: HostTrustRequiredError,
  signal: AbortSignal,
) => Promise<boolean>;

export interface HostTrustRetryOptions {
  readonly sshAdapter: Pick<OpenSshAccessAdapter, "enrollHostKey">;
  readonly signal?: AbortSignal;
  readonly confirmHostTrust?: ConfirmHostTrust;
}

export interface ForegroundConnectOptions {
  readonly gateway: ConnectionGateway;
  readonly sshAdapter: OpenSshAccessAdapter;
  readonly instanceId: string;
  readonly remotePort: number;
  readonly remoteHost?: string;
  readonly localPort?: number;
  readonly context: OperationContext;
  readonly confirmHostTrust?: ConfirmHostTrust;
  readonly onEndpoint: (endpoint: Endpoint) => void;
}

export async function runForegroundConnect(
  options: ForegroundConnectOptions,
): Promise<void> {
  const result = await openWithTrust(options);

  try {
    options.onEndpoint(result.endpoint);
    await result.session.closed;
  } catch (error) {
    try {
      await result.session.close();
    } catch (cleanupError) {
      if (cleanupError !== error) {
        throw new AggregateError(
          [error, cleanupError],
          "Foreground connection failed and cleanup also failed",
        );
      }
    }
    throw error;
  }
}

async function openWithTrust(
  options: ForegroundConnectOptions,
): Promise<OpenEndpointResult> {
  return retryWithHostTrust(
    () =>
      options.gateway.openEndpoint(
        options.instanceId,
        options.remotePort,
        options.remoteHost ?? "127.0.0.1",
        options.context,
        options.localPort,
      ),
    {
      sshAdapter: options.sshAdapter,
      signal: options.context.signal,
      ...(options.confirmHostTrust === undefined
        ? {}
        : { confirmHostTrust: options.confirmHostTrust }),
    },
  );
}

export async function retryWithHostTrust<T>(
  operation: () => Promise<T>,
  options: HostTrustRetryOptions,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isHostTrustRequiredError(error) || options.confirmHostTrust === undefined) {
      throw error;
    }

    const signal = options.signal ?? new AbortController().signal;
    if (!(await options.confirmHostTrust(error, signal))) {
      throw normalizedError(
        "cancelled",
        `SSH host trust was declined for ${error.host}:${error.port}`,
      );
    }

    await options.sshAdapter.enrollHostKey(error, signal);
    return operation();
  }
}
