import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import {
  isHostTrustRequiredError,
  isNormalizedError,
  normalizedError,
  type OperationContext,
} from "@easyai101/easyserver-plugin-sdk";
import type {
  AccessMethodDescriptor,
  ConnectionGateway,
  ConnectionSession,
  Endpoint,
  OpenEndpointResult,
} from "./connection-gateway.js";
import {
  EndpointIntentService,
  type CreateEndpointIntentRequest,
  type EndpointIntentStatus,
} from "./endpoint-intent-service.js";
import type { JsonStateStore } from "./state-store.js";

const MAX_REQUEST_BYTES = 64 * 1024;
const DEFAULT_HEALTH_TIMEOUT_MS = 1_000;
const MAX_RETAINED_FAILED_SESSIONS = 100;

interface PersistentConnectionSessionBase {
  readonly id: string;
  readonly instanceId: string;
  readonly remoteHost: string;
  readonly remotePort: number;
  readonly requestedLocalPort?: number;
  readonly requestedAccessMethodId?: string;
  readonly accessMethod: AccessMethodDescriptor;
  readonly idempotencyKey?: string;
}

export interface PersistentSessionFailure {
  readonly code: string;
  readonly message: string;
}

export interface LivePersistentConnectionSession
  extends PersistentConnectionSessionBase {
  readonly state: "live";
  readonly endpoint: Endpoint;
}

export interface ClosingPersistentConnectionSession
  extends PersistentConnectionSessionBase {
  readonly state: "closing";
  readonly endpoint?: Endpoint;
}

export interface FailedPersistentConnectionSession
  extends PersistentConnectionSessionBase {
  readonly state: "failed";
  readonly failure: PersistentSessionFailure;
}

export type PersistentConnectionSession =
  | LivePersistentConnectionSession
  | ClosingPersistentConnectionSession
  | FailedPersistentConnectionSession;

export interface CreatePersistentSessionRequest {
  readonly instanceId: string;
  readonly remotePort: number;
  readonly remoteHost?: string;
  readonly localPort?: number;
  readonly accessMethodId?: string;
  readonly idempotencyKey?: string;
}

export interface LocalDaemonAddress {
  readonly host: "127.0.0.1";
  readonly port: number;
}

interface EndpointOpener {
  openEndpoint(
    instanceId: string,
    remotePort: number,
    remoteHost: string,
    context: OperationContext,
    localPort?: number,
    accessMethodId?: string,
  ): Promise<OpenEndpointResult>;
}

interface OwnedSession {
  descriptor: PersistentConnectionSession;
  readonly session: ConnectionSession;
  failedAt?: number;
}

interface ParsedCreateSessionRequest {
  readonly instanceId: string;
  readonly remotePort: number;
  readonly remoteHost: string;
  readonly localPort?: number;
  readonly accessMethodId?: string;
  readonly idempotencyKey?: string;
}

interface PendingIdempotentSession {
  readonly request: ParsedCreateSessionRequest;
  readonly result: Promise<LivePersistentConnectionSession | undefined>;
}

export interface LocalConnectionDaemon {
  readonly address: LocalDaemonAddress;
  close(): Promise<void>;
}

export interface LocalDaemonDescriptor {
  readonly version: 1;
  readonly address: LocalDaemonAddress;
  readonly authToken: string;
}

export async function readLocalDaemonDescriptor(
  path: string,
): Promise<LocalDaemonDescriptor | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }

  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Invalid local daemon descriptor");
  }
  const descriptor = value as Record<string, unknown>;
  const address = descriptor.address as Record<string, unknown> | undefined;
  if (
    descriptor.version !== 1 ||
    typeof address !== "object" ||
    address === null ||
    address.host !== "127.0.0.1" ||
    typeof address.port !== "number" ||
    !Number.isInteger(address.port) ||
    address.port < 1 ||
    address.port > 65_535 ||
    typeof descriptor.authToken !== "string" ||
    descriptor.authToken.length === 0
  ) {
    throw new TypeError("Invalid local daemon descriptor");
  }

  return {
    version: 1,
    address: { host: "127.0.0.1", port: address.port },
    authToken: descriptor.authToken,
  };
}

export async function claimLocalDaemonDescriptor(
  path: string,
  descriptor: LocalDaemonDescriptor,
): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const serialized = `${JSON.stringify(descriptor)}\n`;
  await writeFile(path, serialized, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return async () => {
    let current: string;
    try {
      current = await readFile(path, "utf8");
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }

    if (current === serialized) {
      await rm(path, { force: true });
    }
  };
}

export async function removeLocalDaemonDescriptor(path: string): Promise<void> {
  await rm(path, { force: true });
}

export async function startLocalConnectionDaemon(options: {
  readonly gateway: ConnectionGateway | EndpointOpener;
  readonly authToken: string;
  readonly stateStore?: JsonStateStore;
}): Promise<LocalConnectionDaemon> {
  if (options.authToken.length === 0) {
    throw new TypeError("authToken must be non-empty");
  }

  const sessions = new Map<string, OwnedSession>();
  const intentService =
    options.stateStore === undefined
      ? undefined
      : new EndpointIntentService(options.gateway, options.stateStore);
  const sessionIdsByIdempotencyKey = new Map<string, string>();
  const pendingIdempotentSessions = new Map<string, PendingIdempotentSession>();
  const pendingSetups = new Set<AbortController>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let failedSequence = 0;

  const releaseIdempotencyKey = (
    id: string,
    descriptor: PersistentConnectionSession,
  ): void => {
    const key = descriptor.idempotencyKey;
    if (key !== undefined && sessionIdsByIdempotencyKey.get(key) === id) {
      sessionIdsByIdempotencyKey.delete(key);
    }
  };

  const markFailed = (
    id: string,
    owned: OwnedSession,
    error: unknown,
  ): PersistentSessionFailure => {
    const failure = sessionFailure(error);
    if (sessions.get(id) !== owned) {
      return failure;
    }

    const {
      instanceId,
      remoteHost,
      remotePort,
      requestedLocalPort,
      requestedAccessMethodId,
      accessMethod,
      idempotencyKey,
    } = owned.descriptor;
    owned.descriptor = {
      id,
      state: "failed",
      instanceId,
      remoteHost,
      remotePort,
      ...(requestedLocalPort === undefined ? {} : { requestedLocalPort }),
      ...(requestedAccessMethodId === undefined
        ? {}
        : { requestedAccessMethodId }),
      accessMethod,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      failure,
    };
    owned.failedAt = ++failedSequence;

    const failed = [...sessions.entries()]
      .filter(([, candidate]) => candidate.descriptor.state === "failed")
      .sort((left, right) => (left[1].failedAt ?? 0) - (right[1].failedAt ?? 0));
    while (failed.length > MAX_RETAINED_FAILED_SESSIONS) {
      const [expiredId, expired] = failed.shift()!;
      if (sessions.get(expiredId) === expired) {
        sessions.delete(expiredId);
        releaseIdempotencyKey(expiredId, expired.descriptor);
        void expired.session.close().catch(() => {});
      }
    }

    return failure;
  };

  const markClosing = (owned: OwnedSession): void => {
    const descriptor = owned.descriptor;
    owned.descriptor = {
      id: descriptor.id,
      state: "closing",
      ...(descriptor.state !== "failed" && "endpoint" in descriptor
        ? { endpoint: descriptor.endpoint }
        : {}),
      instanceId: descriptor.instanceId,
      remoteHost: descriptor.remoteHost,
      remotePort: descriptor.remotePort,
      ...(descriptor.requestedLocalPort === undefined
        ? {}
        : { requestedLocalPort: descriptor.requestedLocalPort }),
      ...(descriptor.requestedAccessMethodId === undefined
        ? {}
        : { requestedAccessMethodId: descriptor.requestedAccessMethodId }),
      accessMethod: descriptor.accessMethod,
      ...(descriptor.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: descriptor.idempotencyKey }),
    };
    owned.failedAt = undefined;
  };

  const createSession = async (
    input: ParsedCreateSessionRequest,
  ): Promise<LivePersistentConnectionSession | undefined> => {
    const setupController = new AbortController();
    pendingSetups.add(setupController);
    let opened: OpenEndpointResult;
    try {
      opened = await options.gateway.openEndpoint(
        input.instanceId,
        input.remotePort,
        input.remoteHost,
        { signal: setupController.signal },
        input.localPort,
        input.accessMethodId,
      );
    } finally {
      pendingSetups.delete(setupController);
    }
    if (closing) {
      await opened.session.close();
      return undefined;
    }

    const id = randomUUID();
    const descriptor: LivePersistentConnectionSession = {
      id,
      state: "live",
      endpoint: opened.endpoint,
      instanceId: input.instanceId,
      remoteHost: input.remoteHost,
      remotePort: input.remotePort,
      ...(input.localPort === undefined
        ? {}
        : { requestedLocalPort: input.localPort }),
      ...(input.accessMethodId === undefined
        ? {}
        : { requestedAccessMethodId: input.accessMethodId }),
      accessMethod: opened.accessMethod,
      ...(input.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: input.idempotencyKey }),
    };
    const owned: OwnedSession = { descriptor, session: opened.session };
    sessions.set(id, owned);
    if (input.idempotencyKey !== undefined) {
      sessionIdsByIdempotencyKey.set(input.idempotencyKey, id);
    }
    void opened.session.closed.then(
      () => {
        if (sessions.get(id) === owned && owned.descriptor.state === "live") {
          sessions.delete(id);
          releaseIdempotencyKey(id, owned.descriptor);
        }
      },
      (error) => {
        markFailed(id, owned, error);
      },
    );
    return descriptor;
  };

  const server = createServer(async (request, response) => {
    try {
      if (!authorized(request, options.authToken)) {
        sendJson(response, 401, { message: "Unauthorized" });
        return;
      }
      if (closing) {
        sendJson(response, 503, { message: "Daemon is shutting down" });
        return;
      }

      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && request.url === "/intents") {
        if (intentService === undefined) {
          throw normalizedError("unsupported-operation", "Endpoint intents are not configured");
        }
        sendJson(response, 200, intentService.list());
        return;
      }

      if (request.method === "POST" && request.url === "/intents") {
        if (intentService === undefined) {
          throw normalizedError("unsupported-operation", "Endpoint intents are not configured");
        }
        const status = await intentService.create(
          parseCreateIntentRequest(await readJson(request)),
        );
        sendJson(response, 201, status);
        return;
      }

      const intentRoute = parseIntentRoute(request.url);
      if (intentRoute !== undefined && intentService !== undefined) {
        if (request.method === "DELETE" && intentRoute.action === undefined) {
          await intentService.remove(intentRoute.name);
          sendJson(response, 200, { ok: true });
          return;
        }
        if (request.method === "POST" && intentRoute.action === "retry") {
          sendJson(response, 200, intentService.retry(intentRoute.name));
          return;
        }
        if (
          request.method === "POST" &&
          (intentRoute.action === "enable" || intentRoute.action === "disable")
        ) {
          sendJson(
            response,
            200,
            await intentService.setEnabled(
              intentRoute.name,
              intentRoute.action === "enable",
            ),
          );
          return;
        }
      }

      if (request.method === "GET" && request.url === "/sessions") {
        sendJson(
          response,
          200,
          [...sessions.values()].map(({ descriptor }) => descriptor),
        );
        return;
      }

      if (request.method === "POST" && request.url === "/sessions") {
        const input = parseCreateRequest(await readJson(request));
        const key = input.idempotencyKey;

        if (key !== undefined) {
          const existingId = sessionIdsByIdempotencyKey.get(key);
          if (existingId !== undefined) {
            const existing = sessions.get(existingId);
            if (existing === undefined) {
              sessionIdsByIdempotencyKey.delete(key);
            } else {
              assertSameSessionIntent(existing.descriptor, input, key);
              if (existing.descriptor.state !== "live") {
                throw normalizedError(
                  "conflict",
                  `Idempotent Connection Session ${key} is ${existing.descriptor.state}; close it before reusing the key`,
                );
              }
              sendJson(response, 200, existing.descriptor);
              return;
            }
          }

          const pending = pendingIdempotentSessions.get(key);
          if (pending !== undefined) {
            if (!sameSessionIntent(pending.request, input)) {
              throw normalizedError(
                "conflict",
                `Idempotency key ${key} is already in use for a different Connection Session specification`,
              );
            }
            const descriptor = await pending.result;
            if (descriptor === undefined) {
              sendJson(response, 503, { message: "Daemon is shutting down" });
            } else {
              sendJson(response, 200, descriptor);
            }
            return;
          }

          const result = createSession(input);
          pendingIdempotentSessions.set(key, { request: input, result });
          try {
            const descriptor = await result;
            if (descriptor === undefined) {
              sendJson(response, 503, { message: "Daemon is shutting down" });
            } else {
              sendJson(response, 201, descriptor);
            }
          } finally {
            if (pendingIdempotentSessions.get(key)?.result === result) {
              pendingIdempotentSessions.delete(key);
            }
          }
          return;
        }

        const descriptor = await createSession(input);
        if (descriptor === undefined) {
          sendJson(response, 503, { message: "Daemon is shutting down" });
        } else {
          sendJson(response, 201, descriptor);
        }
        return;
      }

      if (request.method === "DELETE" && request.url?.startsWith("/sessions/")) {
        const id = decodeURIComponent(request.url.slice("/sessions/".length));
        const owned = sessions.get(id);
        if (owned === undefined) {
          throw normalizedError("not-found", `Connection Session not found: ${id}`);
        }

        markClosing(owned);
        try {
          await owned.session.close();
        } catch (error) {
          const failure = markFailed(id, owned, error);
          throw normalizedError("plugin-failure", failure.message);
        }

        if (owned.descriptor.state === "failed") {
          throw normalizedError(
            "plugin-failure",
            owned.descriptor.failure.message,
          );
        }
        if (sessions.get(id) === owned) {
          sessions.delete(id);
          releaseIdempotencyKey(id, owned.descriptor);
        }
        sendJson(response, 200, { ok: true });
        return;
      }

      sendJson(response, 404, { message: "Not found" });
    } catch (error) {
      sendControlError(response, error);
    }
  });

  server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeHttpServer(server);
    throw new Error("Failed to determine daemon control address");
  }

  try {
    await intentService?.restore();
  } catch (error) {
    await closeHttpServer(server).catch(() => undefined);
    throw error;
  }

  return {
    address: { host: "127.0.0.1", port: address.port },
    close() {
      closePromise ??= (async () => {
        closing = true;
        const errors: unknown[] = [];
        for (const controller of pendingSetups) {
          controller.abort();
        }

        try {
          await closeHttpServer(server);
        } catch (error) {
          errors.push(error);
        }

        try {
          await intentService?.close();
        } catch (error) {
          errors.push(error);
        }

        const ownedSessions = [...sessions.entries()];
        const results = await Promise.allSettled(
          ownedSessions.map(([, { session }]) => session.close()),
        );
        for (let index = 0; index < results.length; index += 1) {
          const result = results[index];
          const [id, owned] = ownedSessions[index];
          if (result.status === "rejected") {
            const failure = markFailed(id, owned, result.reason);
            errors.push(new Error(`${id}: ${failure.message}`));
          } else if (sessions.get(id) === owned) {
            sessions.delete(id);
          }
        }
        sessions.clear();

        if (errors.length === 1) {
          throw errors[0];
        }
        if (errors.length > 1) {
          throw new AggregateError(errors, "Local daemon shutdown failed");
        }
      })();
      return closePromise;
    },
  };
}

export class LocalDaemonClient {
  constructor(
    private readonly address: LocalDaemonAddress,
    private readonly authToken: string,
  ) {}

  async ping(timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS): Promise<void> {
    await this.#request(
      "GET",
      "/health",
      undefined,
      AbortSignal.timeout(timeoutMs),
    );
  }

  async createSession(
    request: CreatePersistentSessionRequest,
  ): Promise<LivePersistentConnectionSession> {
    return this.#request("POST", "/sessions", request);
  }

  async listSessions(): Promise<readonly PersistentConnectionSession[]> {
    return this.#request("GET", "/sessions");
  }

  async closeSession(id: string): Promise<void> {
    await this.#request("DELETE", `/sessions/${encodeURIComponent(id)}`);
  }

  async listEndpointIntents(): Promise<readonly EndpointIntentStatus[]> {
    return this.#request("GET", "/intents");
  }

  async createEndpointIntent(
    request: CreateEndpointIntentRequest,
  ): Promise<EndpointIntentStatus> {
    return this.#request("POST", "/intents", request);
  }

  async retryEndpointIntent(name: string): Promise<EndpointIntentStatus> {
    return this.#request("POST", `/intents/${encodeURIComponent(name)}/retry`);
  }

  async setEndpointIntentEnabled(
    name: string,
    enabled: boolean,
  ): Promise<EndpointIntentStatus> {
    return this.#request(
      "POST",
      `/intents/${encodeURIComponent(name)}/${enabled ? "enable" : "disable"}`,
    );
  }

  async removeEndpointIntent(name: string): Promise<void> {
    await this.#request("DELETE", `/intents/${encodeURIComponent(name)}`);
  }

  async #request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetch(
      `http://${this.address.host}:${this.address.port}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${this.authToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const text = await response.text();
    const payload = text.length === 0 ? undefined : JSON.parse(text);

    if (!response.ok) {
      if (isNormalizedError(payload)) {
        throw payload;
      }
      throw new Error(
        `Daemon request failed (${response.status})${
          typeof payload?.message === "string" ? `: ${payload.message}` : ""
        }`,
      );
    }

    return payload as T;
  }
}

function sessionFailure(error: unknown): PersistentSessionFailure {
  return {
    code: isNormalizedError(error) ? error.code : "plugin-failure",
    message: "Connection Session cleanup failed",
  };
}

function authorized(request: IncomingMessage, expectedToken: string): boolean {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) {
    return false;
  }

  const actual = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new TypeError("Daemon request body is too large");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    throw new TypeError("Daemon request body is required");
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseCreateIntentRequest(value: unknown): CreateEndpointIntentRequest {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Invalid create-intent request");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.name !== "string") {
    throw new TypeError("Endpoint intent name must be a string");
  }
  if (typeof input.instanceId !== "string") {
    throw new TypeError("Endpoint intent instanceId must be a string");
  }
  if (typeof input.remotePort !== "number") {
    throw new TypeError("Endpoint intent remotePort must be a number");
  }
  if (input.remoteHost !== undefined && typeof input.remoteHost !== "string") {
    throw new TypeError("Endpoint intent remoteHost must be a string");
  }
  if (input.localPort !== undefined && typeof input.localPort !== "number") {
    throw new TypeError("Endpoint intent localPort must be a number");
  }
  if (
    input.accessMethodId !== undefined &&
    typeof input.accessMethodId !== "string"
  ) {
    throw new TypeError("Endpoint intent accessMethodId must be a string");
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new TypeError("Endpoint intent enabled must be a boolean");
  }
  return {
    name: input.name,
    instanceId: input.instanceId,
    remotePort: input.remotePort,
    ...(input.remoteHost === undefined ? {} : { remoteHost: input.remoteHost }),
    ...(input.localPort === undefined ? {} : { localPort: input.localPort }),
    ...(input.accessMethodId === undefined
      ? {}
      : { accessMethodId: input.accessMethodId }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
  };
}

function parseIntentRoute(
  url: string | undefined,
): { readonly name: string; readonly action?: "retry" | "enable" | "disable" } | undefined {
  if (url === undefined || !url.startsWith("/intents/")) {
    return undefined;
  }
  const parts = url.slice("/intents/".length).split("/");
  if (parts.length < 1 || parts.length > 2 || parts[0].length === 0) {
    return undefined;
  }
  const name = decodeURIComponent(parts[0]);
  if (parts.length === 1) {
    return { name };
  }
  const action = parts[1];
  if (action !== "retry" && action !== "enable" && action !== "disable") {
    return undefined;
  }
  return { name, action };
}

function sameSessionIntent(
  left: ParsedCreateSessionRequest,
  right: ParsedCreateSessionRequest,
): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.remoteHost === right.remoteHost &&
    left.remotePort === right.remotePort &&
    left.localPort === right.localPort &&
    left.accessMethodId === right.accessMethodId
  );
}

function assertSameSessionIntent(
  descriptor: PersistentConnectionSession,
  input: ParsedCreateSessionRequest,
  key: string,
): void {
  if (
    descriptor.instanceId !== input.instanceId ||
    descriptor.remoteHost !== input.remoteHost ||
    descriptor.remotePort !== input.remotePort ||
    descriptor.requestedLocalPort !== input.localPort ||
    descriptor.requestedAccessMethodId !== input.accessMethodId
  ) {
    throw normalizedError(
      "conflict",
      `Idempotency key ${key} is already in use for a different Connection Session specification`,
    );
  }
}

function parseCreateRequest(value: unknown): ParsedCreateSessionRequest {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Invalid create-session request");
  }

  const input = value as Record<string, unknown>;
  if (typeof input.instanceId !== "string" || input.instanceId.length === 0) {
    throw new TypeError("instanceId must be non-empty");
  }
  if (
    typeof input.remotePort !== "number" ||
    !Number.isInteger(input.remotePort) ||
    input.remotePort < 1 ||
    input.remotePort > 65_535
  ) {
    throw new TypeError("remotePort must be an integer between 1 and 65535");
  }
  if (
    input.remoteHost !== undefined &&
    (typeof input.remoteHost !== "string" || input.remoteHost.trim().length === 0)
  ) {
    throw new TypeError("remoteHost must be non-empty");
  }
  if (
    input.localPort !== undefined &&
    (typeof input.localPort !== "number" ||
      !Number.isInteger(input.localPort) ||
      input.localPort < 1 ||
      input.localPort > 65_535)
  ) {
    throw new TypeError("localPort must be an integer between 1 and 65535");
  }
  if (
    input.accessMethodId !== undefined &&
    (typeof input.accessMethodId !== "string" ||
      input.accessMethodId.trim().length === 0)
  ) {
    throw new TypeError("accessMethodId must be non-empty");
  }
  if (
    input.idempotencyKey !== undefined &&
    (typeof input.idempotencyKey !== "string" ||
      input.idempotencyKey.trim().length === 0 ||
      input.idempotencyKey.length > 128)
  ) {
    throw new TypeError("idempotencyKey must be a non-empty string up to 128 characters");
  }

  return {
    instanceId: input.instanceId,
    remotePort: input.remotePort,
    remoteHost: input.remoteHost ?? "127.0.0.1",
    ...(input.localPort === undefined ? {} : { localPort: input.localPort }),
    ...(input.accessMethodId === undefined
      ? {}
      : { accessMethodId: input.accessMethodId }),
    ...(input.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: input.idempotencyKey }),
  };
}

function sendControlError(response: ServerResponse, error: unknown): void {
  if (isHostTrustRequiredError(error)) {
    sendJson(response, 409, {
      kind: error.kind,
      code: error.code,
      message: error.message,
      host: error.host,
      port: error.port,
      keyType: error.keyType,
      fingerprint: error.fingerprint,
    });
    return;
  }
  if (isNormalizedError(error)) {
    sendJson(response, error.code === "not-found" ? 404 : 400, {
      kind: error.kind,
      code: error.code,
      message: error.message,
    });
    return;
  }

  sendJson(response, error instanceof TypeError ? 400 : 500, {
    message: error instanceof Error ? error.message : String(error),
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

async function closeHttpServer(server: ReturnType<typeof createServer>): Promise<void> {
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
    server.closeAllConnections();
  });
}
