import { randomUUID } from "node:crypto";
import {
  isNormalizedError,
  normalizedError,
  type HostTrustRequiredError,
  type NormalizedError,
  type OperationContext,
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

export type TuiForegroundConnectionState = "live" | "closing" | "failed";

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
  readonly failure?: NormalizedError;
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
  readonly #listeners = new Set<() => void>();

  constructor(private readonly dependencies: TuiForegroundConnectionDependencies) {}

  list(): readonly TuiForegroundConnection[] {
    return [...this.#records.values()].map((record) => record.descriptor);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
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
    const record = { descriptor, session: result.session };
    this.#records.set(id, record);
    this.#emit();
    void result.session.closed.then(
      () => {
        if (this.#records.get(id) === record && this.#records.delete(id)) {
          this.#emit();
        }
      },
      (error) => this.#markFailed(id, record, error),
    );
    return descriptor;
  }

  async retry(
    id: string,
    context: OperationContext,
    interaction: TuiForegroundConnectionInteraction = {},
  ): Promise<TuiForegroundConnection> {
    const record = this.#records.get(id);
    if (record === undefined || record.descriptor.state !== "failed") {
      throw normalizedError("not-found", "Failed local connection is no longer available");
    }
    const request: TuiForegroundConnectionRequest = {
      instanceId: record.descriptor.instanceId,
      remoteHost: record.descriptor.remoteHost,
      remotePort: record.descriptor.remotePort,
      ...(record.descriptor.requestedLocalPort === undefined
        ? {}
        : { localPort: record.descriptor.requestedLocalPort }),
      accessMethodId: record.descriptor.accessMethod.id,
    };
    const replacement = await this.open(request, context, interaction);
    if (this.#records.get(id) === record && this.#records.delete(id)) {
      this.#emit();
    }
    return replacement;
  }

  async close(id: string): Promise<void> {
    const record = this.#records.get(id);
    if (record === undefined) {
      return;
    }
    if (record.descriptor.state === "failed") {
      this.#records.delete(id);
      this.#emit();
      return;
    }
    record.descriptor = { ...record.descriptor, state: "closing" };
    this.#emit();
    try {
      await record.session.close();
    } catch (error) {
      this.#markFailed(id, record, error);
      throw error;
    }
    if (this.#records.get(id) === record && this.#records.delete(id)) {
      this.#emit();
    }
  }

  async closeAll(): Promise<void> {
    const records = [...this.#records.values()];
    const closable = records.filter((record) => record.descriptor.state !== "failed");
    for (const record of closable) {
      record.descriptor = { ...record.descriptor, state: "closing" };
    }
    if (closable.length > 0) {
      this.#emit();
    }
    const outcomes = await Promise.allSettled(
      closable.map((record) => record.session.close()),
    );
    const errors = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (this.#records.size > 0) {
      this.#records.clear();
      this.#emit();
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "TUI-owned connection cleanup failed");
    }
  }

  #markFailed(id: string, record: TuiForegroundConnectionRecord, error: unknown): void {
    if (this.#records.get(id) !== record || record.descriptor.state === "failed") {
      return;
    }
    record.descriptor = {
      ...record.descriptor,
      state: "failed",
      failure: foregroundConnectionFailure(error),
    };
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

function foregroundConnectionFailure(error: unknown): NormalizedError {
  if (!isNormalizedError(error)) {
    return normalizedError(
      "plugin-failure",
      "The local connection ended unexpectedly.",
    );
  }
  const safeMessage = [
    "SSH public-key authentication was rejected by the server.",
    "SSH authentication was rejected by the server.",
    "SSH host identity no longer matches the trusted host key.",
    "SSH on the server is not ready or reachable yet.",
    "SSH connected, but the requested service port is not accepting connections yet.",
    "SSH connected, but the requested service could not be reached from the server.",
    "SSH connected, but this server does not permit TCP forwarding.",
    "The SSH route closed before TCP forwarding was established.",
    "OpenSSH connection failed unexpectedly.",
    "Local OpenSSH client could not be started. Install or enable OpenSSH Client and retry.",
  ].includes(error.message)
    ? error.message
    : "The local connection ended unexpectedly.";
  return normalizedError(error.code, safeMessage);
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
