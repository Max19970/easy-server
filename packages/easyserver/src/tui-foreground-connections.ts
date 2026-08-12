import { randomUUID } from "node:crypto";
import type {
  HostTrustRequiredError,
  OperationContext,
} from "@easyai101/easyserver-plugin-sdk";
import { retryWithHostTrust, type ConfirmHostTrust } from "./connect-command.js";
import type {
  AccessMethodDescriptor,
  ConnectionSession,
  OpenEndpointResult,
} from "./connection-gateway.js";
import {
  createHostRuntime,
  resolveHostRuntimePaths,
  type HostRuntimePaths,
} from "./host-runtime.js";

export interface TuiForegroundConnectionRequest {
  readonly instanceId: string;
  readonly remoteHost?: string;
  readonly remotePort: number;
  readonly localPort?: number;
  readonly accessMethodId: string;
}

export type TuiForegroundConnectionState = "live" | "closing";

export interface TuiForegroundConnection {
  readonly id: string;
  readonly instanceId: string;
  readonly remoteHost: string;
  readonly remotePort: number;
  readonly requestedLocalPort?: number;
  readonly endpoint: {
    readonly host: "127.0.0.1";
    readonly port: number;
  };
  readonly accessMethod: AccessMethodDescriptor;
  readonly state: TuiForegroundConnectionState;
}

export interface TuiForegroundConnectionInteraction {
  readonly confirmHostTrust?: ConfirmHostTrust;
}

interface TuiForegroundConnectionRecord {
  descriptor: TuiForegroundConnection;
  readonly session: ConnectionSession;
}

export interface TuiForegroundConnectionDependencies {
  listAccessMethods(
    instanceId: string,
    context: OperationContext,
  ): Promise<readonly AccessMethodDescriptor[]>;
  openEndpoint(
    request: TuiForegroundConnectionRequest,
    context: OperationContext,
  ): Promise<OpenEndpointResult>;
  enrollHostKey(trust: HostTrustRequiredError, signal: AbortSignal): Promise<void>;
}

export class TuiForegroundConnectionOperations {
  readonly #records = new Map<string, TuiForegroundConnectionRecord>();

  constructor(private readonly dependencies: TuiForegroundConnectionDependencies) {}

  list(): readonly TuiForegroundConnection[] {
    return [...this.#records.values()].map((record) => record.descriptor);
  }

  listAccessMethods(
    instanceId: string,
    context: OperationContext,
  ): Promise<readonly AccessMethodDescriptor[]> {
    return this.dependencies.listAccessMethods(instanceId, context);
  }

  async open(
    request: TuiForegroundConnectionRequest,
    context: OperationContext,
    interaction: TuiForegroundConnectionInteraction = {},
  ): Promise<TuiForegroundConnection> {
    const result = await retryWithHostTrust(
      () => this.dependencies.openEndpoint(request, context),
      {
        sshAdapter: { enrollHostKey: this.dependencies.enrollHostKey },
        signal: context.signal,
        ...(interaction.confirmHostTrust === undefined
          ? {}
          : { confirmHostTrust: interaction.confirmHostTrust }),
      },
    );
    const id = `foreground:${randomUUID()}`;
    const descriptor: TuiForegroundConnection = {
      id,
      instanceId: request.instanceId,
      remoteHost: request.remoteHost ?? "127.0.0.1",
      remotePort: request.remotePort,
      ...(request.localPort === undefined
        ? {}
        : { requestedLocalPort: request.localPort }),
      endpoint: result.endpoint,
      accessMethod: result.accessMethod,
      state: "live",
    };
    this.#records.set(id, { descriptor, session: result.session });
    void result.session.closed.then(
      () => this.#records.delete(id),
      () => this.#records.delete(id),
    );
    return descriptor;
  }

  async close(id: string): Promise<void> {
    const record = this.#records.get(id);
    if (record === undefined) {
      return;
    }
    record.descriptor = { ...record.descriptor, state: "closing" };
    await record.session.close();
    this.#records.delete(id);
  }

  async closeAll(): Promise<void> {
    const records = [...this.#records.values()];
    for (const record of records) {
      record.descriptor = { ...record.descriptor, state: "closing" };
    }
    const outcomes = await Promise.allSettled(
      records.map((record) => record.session.close()),
    );
    const errors = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    this.#records.clear();
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "TUI-owned connection cleanup failed");
    }
  }
}

export function createDefaultTuiForegroundConnectionOperations(
  paths: HostRuntimePaths = resolveHostRuntimePaths(),
): TuiForegroundConnectionOperations {
  let runtimePromise: ReturnType<typeof createHostRuntime> | undefined;
  const runtime = () => (runtimePromise ??= createHostRuntime({ paths }));

  return new TuiForegroundConnectionOperations({
    async listAccessMethods(instanceId, context) {
      return (await runtime()).connectionGateway.listAccessMethods(instanceId, context);
    },
    async openEndpoint(request, context) {
      return (await runtime()).connectionGateway.openEndpoint(
        request.instanceId,
        request.remotePort,
        request.remoteHost ?? "127.0.0.1",
        context,
        request.localPort,
        request.accessMethodId,
      );
    },
    async enrollHostKey(trust, signal) {
      await (await runtime()).sshAdapter.enrollHostKey(trust, signal);
    },
  });
}
