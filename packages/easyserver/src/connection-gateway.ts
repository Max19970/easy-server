import { createServer, type Server, type Socket } from "node:net";
import {
  normalizedError,
  parseAccessMethods,
  type AccessChannel,
  type AccessMethod,
  type AccessTransportSession,
  type OperationContext,
  type SecretReference,
  type TcpForwardTarget,
} from "@easyai101/easyserver-plugin-sdk";
import { AccessAdapterRegistry } from "./access-adapter-registry.js";
import { HostOperationRunner } from "./host-operation.js";
import {
  providerOperationContext,
  ProviderRegistry,
} from "./provider-registry.js";
import type { SecretStore } from "./secret-store.js";
import { JsonStateStore } from "./state-store.js";

export interface Endpoint {
  readonly host: "127.0.0.1";
  readonly port: number;
}

export interface ConnectionSession {
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export interface OpenEndpointResult {
  readonly endpoint: Endpoint;
  readonly session: ConnectionSession;
}

type Cleanup = () => void | Promise<void>;

export class ConnectionGateway {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly accessAdapters: AccessAdapterRegistry,
    private readonly stateStore: JsonStateStore,
    private readonly secretStore?: SecretStore,
    private readonly operations = new HostOperationRunner(),
  ) {}

  async openEndpoint(
    instanceId: string,
    remotePort: number,
    remoteHost?: string,
    context?: OperationContext,
    localPort?: number,
  ): Promise<OpenEndpointResult>;
  async openEndpoint(
    instanceId: string,
    remotePort: number,
    context: OperationContext,
    remoteHost?: string,
    localPort?: number,
  ): Promise<OpenEndpointResult>;
  async openEndpoint(
    instanceId: string,
    remotePort: number,
    remoteHostOrContext: string | OperationContext = "127.0.0.1",
    contextOrRemoteHost?: OperationContext | string,
    localPort?: number,
  ): Promise<OpenEndpointResult> {
    const remoteHost =
      typeof remoteHostOrContext === "string"
        ? remoteHostOrContext
        : typeof contextOrRemoteHost === "string"
          ? contextOrRemoteHost
          : "127.0.0.1";
    const context =
      typeof remoteHostOrContext === "string"
        ? typeof contextOrRemoteHost === "object"
          ? contextOrRemoteHost
          : { signal: new AbortController().signal }
        : remoteHostOrContext;

    validateTarget(remoteHost, remotePort);
    validateLocalPort(localPort);
    if (context.signal.aborted) {
      throw normalizedError("cancelled", "Connection setup was cancelled");
    }

    const state = await this.stateStore.read();
    const binding = state.instances?.find((candidate) => candidate.id === instanceId);
    if (binding === undefined) {
      throw normalizedError("not-found", `Compute Instance not found: ${instanceId}`);
    }

    const admission = this.providers.acquire(binding.providerId);
    if (admission === undefined) {
      throw normalizedError(
        "provider-unavailable",
        `Provider is not available: ${binding.providerId}`,
      );
    }

    const scope = new CleanupScope();
    scope.register(() => admission.release());
    let pendingTransport: Promise<AccessTransportSession> | undefined;
    let transportOwnedByScope = false;

    try {
      if (admission.provider.getAccessMethods === undefined) {
        throw normalizedError(
          "unsupported-operation",
          `Provider ${binding.providerId} does not expose Access Methods`,
        );
      }

      const methods = parseAccessMethods(
        await this.operations.run(
          "read",
          `Provider ${binding.providerId} getAccessMethods`,
          context,
          (operationContext) =>
            admission.provider.getAccessMethods!(
              binding.providerExternalId,
              providerOperationContext(admission, operationContext),
            ),
        ),
      );
      const selected = methods
        .map((method) => ({
          method,
          adapter: this.accessAdapters.resolveTcpForward(method, admission),
        }))
        .find(
          (candidate): candidate is typeof candidate & {
            adapter: NonNullable<typeof candidate.adapter>;
          } => candidate.adapter !== undefined,
        );

      if (selected === undefined) {
        throw normalizedError(
          "unsupported-operation",
          `No TCP-forward Access Method is available for ${instanceId}`,
        );
      }

      const target: TcpForwardTarget = { host: remoteHost, port: remotePort };
      const allowedSecretRefs = accessMethodSecretRefs(selected.method);
      const allowedCredentialIds = accessMethodDeferredCredentialIds(selected.method);
      const transport = await this.operations.run(
        "read",
        `Access setup for ${instanceId}`,
        context,
        (operationContext) => {
          pendingTransport = selected.adapter.openTcpForward(
            selected.method,
            binding.providerExternalId,
            target,
            {
              signal: operationContext.signal,
              registerCleanup(cleanup) {
                scope.register(cleanup);
              },
              resolveSecret: async (ref) => {
                if (!allowedSecretRefs.has(ref)) {
                  throw normalizedError(
                    "authentication",
                    "Access Adapter requested a secret that is not declared by the selected Access Method",
                  );
                }
                if (this.secretStore === undefined) {
                  throw normalizedError(
                    "authentication",
                    "No Secret Store is configured for the selected Access Method",
                  );
                }

                const secret = await this.secretStore.get(
                  ref,
                  operationContext.signal,
                );
                if (secret === undefined) {
                  throw normalizedError(
                    "authentication",
                    `Secret is unavailable: ${ref}`,
                  );
                }

                return secret;
              },
              resolveCredential: async (id) => {
                if (!allowedCredentialIds.has(id)) {
                  throw normalizedError(
                    "authentication",
                    "Access Adapter requested a provider credential that is not declared by the selected Access Method",
                  );
                }
                if (admission.provider.resolveAccessCredential === undefined) {
                  throw normalizedError(
                    "plugin-failure",
                    `Provider ${binding.providerId} declared deferred access credential ${id} without a resolver`,
                  );
                }

                const credential = await admission.provider.resolveAccessCredential(
                  binding.providerExternalId,
                  id,
                  providerOperationContext(admission, operationContext),
                );
                if (credential === undefined) {
                  throw normalizedError(
                    "authentication",
                    `Provider access credential is unavailable: ${id}`,
                  );
                }
                return credential;
              },
            },
          );
          return pendingTransport;
        },
      );
      transportOwnedByScope = true;
      scope.register(() => transport.close());

      let session: LiveConnectionSession | undefined;
      const server = createServer((socket) => {
        if (session === undefined) {
          socket.destroy();
          return;
        }

        session.accept(socket);
      });
      scope.register(() => closeServer(server));
      await listenLoopback(server, localPort);

      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Failed to determine local Endpoint address");
      }

      session = new LiveConnectionSession(server, transport, scope);

      const onAbort = () => {
        session.close().catch(() => {});
      };
      context.signal.addEventListener("abort", onAbort, { once: true });
      scope.register(() => context.signal.removeEventListener("abort", onAbort));

      if (context.signal.aborted) {
        await session.close();
        throw normalizedError("cancelled", "Connection setup was cancelled");
      }

      return {
        endpoint: { host: "127.0.0.1", port: address.port },
        session,
      };
    } catch (error) {
      if (pendingTransport !== undefined && !transportOwnedByScope) {
        void pendingTransport
          .then((transport) => transport.close())
          .catch(() => undefined);
      }
      try {
        await scope.close();
      } catch (cleanupError) {
        const cleanupErrors =
          cleanupError instanceof AggregateError
            ? cleanupError.errors
            : [cleanupError];
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Connection setup failed and cleanup also failed",
        );
      }
      throw error;
    }
  }
}

class LiveConnectionSession implements ConnectionSession {
  readonly #controller = new AbortController();
  readonly #connections = new Map<Socket, AccessChannel | undefined>();
  readonly #pendingCleanups = new Set<Promise<void>>();
  readonly #lifecycleErrors: unknown[] = [];
  readonly closed: Promise<void>;
  readonly #resolveClosed: () => void;
  readonly #rejectClosed: (reason: unknown) => void;
  #closePromise: Promise<void> | undefined;
  #closeSettledSuccessfully = false;
  #lateCleanupFailure: Promise<void> | undefined;

  constructor(
    private readonly server: Server,
    private readonly transport: AccessTransportSession,
    private readonly scope: CleanupScope,
  ) {
    let resolveClosed!: () => void;
    let rejectClosed!: (reason: unknown) => void;
    this.closed = new Promise<void>((resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    });
    this.#resolveClosed = resolveClosed;
    this.#rejectClosed = rejectClosed;
    void this.closed.catch(() => undefined);
  }

  accept(socket: Socket): void {
    if (this.#controller.signal.aborted) {
      socket.destroy();
      return;
    }

    const clientController = new AbortController();
    socket.on("error", () => undefined);
    this.#connections.set(socket, undefined);
    socket.once("close", () => {
      clientController.abort();
      const channel = this.#connections.get(socket);
      if (!this.#connections.delete(socket) || channel === undefined) {
        return;
      }

      this.#trackChannelCleanup(channel);
    });
    void this.#openConnection(socket, clientController.signal);
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closePromise = this.#close();
      void this.#closePromise.then(
        () => {
          this.#closeSettledSuccessfully = true;
          this.#resolveClosed();
        },
        this.#rejectClosed,
      );
    }
    return this.#lateCleanupFailure ?? this.#closePromise;
  }

  async #openConnection(socket: Socket, clientSignal: AbortSignal): Promise<void> {
    try {
      const channel = await this.transport.openChannel({
        signal: AbortSignal.any([this.#controller.signal, clientSignal]),
      });

      if (
        this.#controller.signal.aborted ||
        socket.destroyed ||
        !this.#connections.has(socket)
      ) {
        socket.destroy();
        this.#trackChannelCleanup(channel);
        return;
      }

      this.#connections.set(socket, channel);
      channel.stream.on("error", () => socket.destroy());
      channel.stream.once("close", () => socket.destroy());
      socket.pipe(channel.stream);
      channel.stream.pipe(socket);
    } catch {
      const tracked = this.#connections.delete(socket);
      const clientGone = clientSignal.aborted || socket.destroyed || !tracked;
      socket.destroy();
      if (!this.#controller.signal.aborted && !clientGone) {
        void this.close().catch(() => undefined);
      }
    }
  }

  #trackChannelCleanup(channel: AccessChannel): void {
    channel.stream.destroy();
    let cleanup: Promise<void>;
    cleanup = Promise.resolve()
      .then(() => channel.close())
      .catch((error) => {
        this.#lifecycleErrors.push(error);
        if (this.#closeSettledSuccessfully) {
          const errors = [...this.#lifecycleErrors];
          const failure =
            errors.length === 1
              ? errors[0]
              : new AggregateError(errors, "Connection session cleanup failed");
          this.#lateCleanupFailure = Promise.reject(failure);
          void this.#lateCleanupFailure.catch(() => undefined);
        }
        void this.close().catch(() => undefined);
      })
      .finally(() => {
        this.#pendingCleanups.delete(cleanup);
      });
    this.#pendingCleanups.add(cleanup);
  }

  async #close(): Promise<void> {
    this.#controller.abort();
    const connections = [...this.#connections.entries()];
    this.#connections.clear();

    for (const [socket, channel] of connections) {
      socket.destroy();
      if (channel !== undefined) {
        this.#trackChannelCleanup(channel);
      }
    }

    await Promise.all([...this.#pendingCleanups]);

    try {
      await this.scope.close();
    } catch (error) {
      if (error instanceof AggregateError) {
        this.#lifecycleErrors.push(...error.errors);
      } else {
        this.#lifecycleErrors.push(error);
      }
    }

    await Promise.all([...this.#pendingCleanups]);

    if (this.#lifecycleErrors.length === 1) {
      throw this.#lifecycleErrors[0];
    }
    if (this.#lifecycleErrors.length > 1) {
      throw new AggregateError(
        this.#lifecycleErrors,
        "Connection session cleanup failed",
      );
    }
  }
}

class CleanupScope {
  readonly #cleanups: Cleanup[] = [];
  #closePromise: Promise<void> | undefined;

  register(cleanup: Cleanup): void {
    if (this.#closePromise !== undefined) {
      throw new Error("Cannot register cleanup after scope close has started");
    }

    this.#cleanups.push(cleanup);
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    const errors: unknown[] = [];

    for (const cleanup of this.#cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Multiple cleanup operations failed");
    }
  }
}

async function listenLoopback(
  server: Server,
  localPort?: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      if (localPort !== undefined && errorCode(error) === "EADDRINUSE") {
        reject(
          normalizedError(
            "conflict",
            `Local Endpoint port is already in use: ${localPort}`,
            error,
          ),
        );
        return;
      }
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({
      host: "127.0.0.1",
      port: localPort ?? 0,
      exclusive: true,
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

function accessMethodSecretRefs(method: AccessMethod): Set<SecretReference> {
  const refs = new Set<SecretReference>();

  for (const source of method.credentialSources ?? []) {
    if (source.kind === "secret-ref") {
      refs.add(source.secretRef);
    }
  }
  if (method.ssh?.privateKeySecretRef !== undefined) {
    refs.add(method.ssh.privateKeySecretRef);
  }

  return refs;
}

function accessMethodDeferredCredentialIds(method: AccessMethod): Set<string> {
  const ids = new Set<string>();
  for (const source of method.credentialSources ?? []) {
    if (source.kind === "provider-deferred") {
      ids.add(source.id);
    }
  }
  return ids;
}

function validateLocalPort(port: number | undefined): void {
  if (port === undefined) {
    return;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("localPort must be an integer between 1 and 65535");
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
}

function validateTarget(host: string, port: number): void {
  if (host.trim().length === 0) {
    throw new TypeError("remoteHost must be non-empty");
  }

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("remotePort must be an integer between 1 and 65535");
  }
}
