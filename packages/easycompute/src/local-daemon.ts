import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import {
  isHostTrustRequiredError,
  isNormalizedError,
  normalizedError,
  type OperationContext,
} from "@easycompute/plugin-sdk";
import type {
  ConnectionGateway,
  ConnectionSession,
  Endpoint,
  OpenEndpointResult,
} from "./connection-gateway.js";

const MAX_REQUEST_BYTES = 64 * 1024;
const DEFAULT_HEALTH_TIMEOUT_MS = 1_000;

export interface PersistentConnectionSession {
  readonly id: string;
  readonly endpoint: Endpoint;
  readonly instanceId: string;
  readonly remoteHost: string;
  readonly remotePort: number;
}

export interface CreatePersistentSessionRequest {
  readonly instanceId: string;
  readonly remotePort: number;
  readonly remoteHost?: string;
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
  ): Promise<OpenEndpointResult>;
}

interface OwnedSession {
  readonly descriptor: PersistentConnectionSession;
  readonly session: ConnectionSession;
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
}): Promise<LocalConnectionDaemon> {
  if (options.authToken.length === 0) {
    throw new TypeError("authToken must be non-empty");
  }

  const sessions = new Map<string, OwnedSession>();
  const pendingSetups = new Set<AbortController>();
  let closing = false;
  let closePromise: Promise<void> | undefined;

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
        const setupController = new AbortController();
        pendingSetups.add(setupController);
        let opened: OpenEndpointResult;
        try {
          opened = await options.gateway.openEndpoint(
            input.instanceId,
            input.remotePort,
            input.remoteHost,
            { signal: setupController.signal },
          );
        } finally {
          pendingSetups.delete(setupController);
        }
        if (closing) {
          await opened.session.close();
          sendJson(response, 503, { message: "Daemon is shutting down" });
          return;
        }
        const id = randomUUID();
        const descriptor: PersistentConnectionSession = {
          id,
          endpoint: opened.endpoint,
          instanceId: input.instanceId,
          remoteHost: input.remoteHost,
          remotePort: input.remotePort,
        };
        sessions.set(id, { descriptor, session: opened.session });
        void opened.session.closed.then(
          () => sessions.delete(id),
          () => sessions.delete(id),
        );
        sendJson(response, 201, descriptor);
        return;
      }

      if (request.method === "DELETE" && request.url?.startsWith("/sessions/")) {
        const id = decodeURIComponent(request.url.slice("/sessions/".length));
        const owned = sessions.get(id);
        if (owned === undefined) {
          throw normalizedError("not-found", `Connection Session not found: ${id}`);
        }

        try {
          await owned.session.close();
        } finally {
          sessions.delete(id);
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

        const ownedSessions = [...sessions.values()];
        sessions.clear();
        const results = await Promise.allSettled(
          ownedSessions.map(({ session }) => session.close()),
        );
        for (const result of results) {
          if (result.status === "rejected") {
            errors.push(result.reason);
          }
        }

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
  ): Promise<PersistentConnectionSession> {
    return this.#request("POST", "/sessions", request);
  }

  async listSessions(): Promise<readonly PersistentConnectionSession[]> {
    return this.#request("GET", "/sessions");
  }

  async closeSession(id: string): Promise<void> {
    await this.#request("DELETE", `/sessions/${encodeURIComponent(id)}`);
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

function parseCreateRequest(value: unknown): {
  readonly instanceId: string;
  readonly remotePort: number;
  readonly remoteHost: string;
} {
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

  return {
    instanceId: input.instanceId,
    remotePort: input.remotePort,
    remoteHost: input.remoteHost ?? "127.0.0.1",
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
