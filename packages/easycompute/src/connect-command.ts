import {
  isHostTrustRequiredError,
  normalizedError,
  type HostTrustRequiredError,
  type OperationContext,
} from "@easycompute/plugin-sdk";
import {
  type ConnectionGateway,
  type Endpoint,
  type OpenEndpointResult,
} from "./connection-gateway.js";
import type { OpenSshAccessAdapter } from "./ssh-access-adapter.js";

export interface ForegroundConnectOptions {
  readonly gateway: ConnectionGateway;
  readonly sshAdapter: OpenSshAccessAdapter;
  readonly instanceId: string;
  readonly remotePort: number;
  readonly remoteHost?: string;
  readonly context: OperationContext;
  readonly confirmHostTrust?: (
    trust: HostTrustRequiredError,
    signal: AbortSignal,
  ) => Promise<boolean>;
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
  try {
    return await options.gateway.openEndpoint(
      options.instanceId,
      options.remotePort,
      options.remoteHost ?? "127.0.0.1",
      options.context,
    );
  } catch (error) {
    if (!isHostTrustRequiredError(error) || options.confirmHostTrust === undefined) {
      throw error;
    }

    if (!(await options.confirmHostTrust(error, options.context.signal))) {
      throw normalizedError(
        "cancelled",
        `SSH host trust was declined for ${error.host}:${error.port}`,
      );
    }

    await options.sshAdapter.enrollHostKey(error, options.context.signal);
    return options.gateway.openEndpoint(
      options.instanceId,
      options.remotePort,
      options.remoteHost ?? "127.0.0.1",
      options.context,
    );
  }
}
