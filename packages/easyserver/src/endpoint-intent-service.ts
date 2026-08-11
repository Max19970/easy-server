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
import { JsonStateStore, type EndpointIntent } from "./state-store.js";

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

export interface CreateEndpointIntentRequest {
  readonly name: string;
  readonly instanceId: string;
  readonly remotePort: number;
  readonly remoteHost?: string;
  readonly localPort?: number;
  readonly accessMethodId?: string;
  readonly enabled?: boolean;
}

export interface EndpointIntentFailure {
  readonly code: string;
  readonly message: string;
}

export type EndpointIntentStatus =
  | (EndpointIntent & { readonly state: "disabled" | "starting" })
  | (EndpointIntent & {
      readonly state: "live";
      readonly endpoint: Endpoint;
      readonly accessMethod: AccessMethodDescriptor;
    })
  | (EndpointIntent & {
      readonly state: "error";
      readonly failure: EndpointIntentFailure;
    });

interface RuntimeIntent {
  definition: EndpointIntent;
  generation: number;
  status: EndpointIntentStatus;
  controller?: AbortController;
  session?: ConnectionSession;
  realization?: Promise<void>;
}

export class EndpointIntentService {
  readonly #intents = new Map<string, RuntimeIntent>();
  readonly #removedCleanupSessions = new Map<string, ConnectionSession>();
  readonly #realizations = new Set<Promise<void>>();
  #closing = false;

  constructor(
    private readonly gateway: ConnectionGateway | EndpointOpener,
    private readonly store: JsonStateStore,
  ) {}

  async restore(): Promise<void> {
    const state = await this.store.read();
    for (const definition of state.endpointIntents ?? []) {
      this.#intents.set(definition.name, {
        definition,
        generation: 0,
        status: definition.enabled
          ? { ...definition, state: "starting" }
          : { ...definition, state: "disabled" },
      });
    }
    for (const definition of state.endpointIntents ?? []) {
      if (definition.enabled) {
        await this.#startRealization(definition.name);
      }
    }
  }

  list(): readonly EndpointIntentStatus[] {
    return [...this.#intents.values()].map(({ status }) => status);
  }

  async create(request: CreateEndpointIntentRequest): Promise<EndpointIntentStatus> {
    const definition = normalizeIntent(request);
    if (this.#removedCleanupSessions.has(definition.name)) {
      throw normalizedError(
        "conflict",
        `Endpoint intent ${definition.name} is awaiting cleanup; retry remove before reusing the name`,
      );
    }
    await this.store.update((state) => {
      if ((state.endpointIntents ?? []).some((intent) => intent.name === definition.name)) {
        throw normalizedError(
          "conflict",
          `Endpoint intent already exists: ${definition.name}`,
        );
      }
      return {
        ...state,
        endpointIntents: [...(state.endpointIntents ?? []), definition],
      };
    });

    const runtime: RuntimeIntent = {
      definition,
      generation: 0,
      status: definition.enabled
        ? { ...definition, state: "starting" }
        : { ...definition, state: "disabled" },
    };
    this.#intents.set(definition.name, runtime);
    if (definition.enabled) {
      void this.#startRealization(definition.name);
    }
    return runtime.status;
  }

  async setEnabled(name: string, enabled: boolean): Promise<EndpointIntentStatus> {
    const existing = this.#intents.get(name);
    if (existing !== undefined && existing.definition.enabled === enabled) {
      if (!enabled && existing.session !== undefined) {
        await existing.session.close();
        existing.session = undefined;
      }
      return existing.status;
    }
    if (enabled && existing?.session !== undefined) {
      await existing.session.close();
      existing.session = undefined;
    }

    const definition = await this.#updateDefinition(name, (intent) => ({
      ...intent,
      enabled,
    }));
    const runtime = this.#runtime(name, definition);
    runtime.definition = definition;
    const pending = runtime.realization;
    runtime.generation += 1;
    runtime.controller?.abort();
    runtime.controller = undefined;

    if (!enabled) {
      runtime.status = { ...definition, state: "disabled" };
      await pending;
      if (runtime.session !== undefined) {
        const session = runtime.session;
        await session.close();
        if (runtime.session === session) {
          runtime.session = undefined;
        }
      }
      return runtime.status;
    }

    runtime.status = { ...definition, state: "starting" };
    void this.#startRealization(name);
    return runtime.status;
  }

  retry(name: string): EndpointIntentStatus {
    const runtime = this.#intents.get(name);
    if (runtime === undefined) {
      throw normalizedError("not-found", `Endpoint intent not found: ${name}`);
    }
    if (!runtime.definition.enabled) {
      throw normalizedError("conflict", `Endpoint intent is disabled: ${name}`);
    }
    if (runtime.status.state === "live" || runtime.status.state === "starting") {
      return runtime.status;
    }
    runtime.status = { ...runtime.definition, state: "starting" };
    void this.#startRealization(name);
    return runtime.status;
  }

  async remove(name: string): Promise<void> {
    const pendingCleanup = this.#removedCleanupSessions.get(name);
    if (pendingCleanup !== undefined) {
      await pendingCleanup.close();
      this.#removedCleanupSessions.delete(name);
      return;
    }

    let found = false;
    await this.store.update((state) => {
      const current = state.endpointIntents ?? [];
      const endpointIntents = current.filter((intent) => intent.name !== name);
      found = endpointIntents.length !== current.length;
      if (!found) {
        return state;
      }
      return {
        ...state,
        ...(endpointIntents.length === 0 ? { endpointIntents: undefined } : { endpointIntents }),
      };
    });
    if (!found) {
      throw normalizedError("not-found", `Endpoint intent not found: ${name}`);
    }

    const runtime = this.#intents.get(name);
    if (runtime === undefined) {
      return;
    }
    this.#intents.delete(name);
    const pending = runtime.realization;
    runtime.generation += 1;
    runtime.controller?.abort();
    await pending;
    if (runtime.session !== undefined) {
      try {
        await runtime.session.close();
      } catch (error) {
        this.#removedCleanupSessions.set(name, runtime.session);
        throw error;
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closing) {
      return;
    }
    this.#closing = true;
    for (const runtime of this.#intents.values()) {
      runtime.generation += 1;
      runtime.controller?.abort();
    }
    await Promise.allSettled([...this.#realizations]);

    const sessions = new Set<ConnectionSession>(
      this.#removedCleanupSessions.values(),
    );
    for (const runtime of this.#intents.values()) {
      if (runtime.session !== undefined) {
        sessions.add(runtime.session);
      }
    }
    const results = await Promise.allSettled(
      [...sessions].map((session) => session.close()),
    );
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Endpoint intent cleanup failed");
    }
  }

  async #updateDefinition(
    name: string,
    update: (intent: EndpointIntent) => EndpointIntent,
  ): Promise<EndpointIntent> {
    let updated: EndpointIntent | undefined;
    await this.store.update((state) => {
      const endpointIntents = (state.endpointIntents ?? []).map((intent) => {
        if (intent.name !== name) {
          return intent;
        }
        updated = update(intent);
        return updated;
      });
      return updated === undefined ? state : { ...state, endpointIntents };
    });
    if (updated === undefined) {
      throw normalizedError("not-found", `Endpoint intent not found: ${name}`);
    }
    return updated;
  }

  #runtime(name: string, definition: EndpointIntent): RuntimeIntent {
    const existing = this.#intents.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const runtime: RuntimeIntent = {
      definition,
      generation: 0,
      status: definition.enabled
        ? { ...definition, state: "starting" }
        : { ...definition, state: "disabled" },
    };
    this.#intents.set(name, runtime);
    return runtime;
  }

  #startRealization(name: string): Promise<void> {
    const runtime = this.#intents.get(name);
    if (runtime === undefined) {
      return Promise.resolve();
    }
    const realization = this.#realize(name).finally(() => {
      this.#realizations.delete(realization);
      if (runtime.realization === realization) {
        runtime.realization = undefined;
      }
    });
    runtime.realization = realization;
    this.#realizations.add(realization);
    return realization;
  }

  async #realize(name: string): Promise<void> {
    const runtime = this.#intents.get(name);
    if (runtime === undefined || !runtime.definition.enabled || this.#closing) {
      return;
    }

    runtime.generation += 1;
    const generation = runtime.generation;
    runtime.controller?.abort();
    const controller = new AbortController();
    runtime.controller = controller;
    runtime.status = { ...runtime.definition, state: "starting" };

    let opened: OpenEndpointResult;
    try {
      opened = await this.gateway.openEndpoint(
        runtime.definition.instanceId,
        runtime.definition.remotePort,
        runtime.definition.remoteHost,
        { signal: controller.signal },
        runtime.definition.localPort,
        runtime.definition.accessMethodId,
      );
    } catch (error) {
      const current = this.#intents.get(name);
      if (
        current === runtime &&
        current.generation === generation &&
        current.definition.enabled &&
        !this.#closing
      ) {
        current.controller = undefined;
        current.status = {
          ...current.definition,
          state: "error",
          failure: intentFailure(error),
        };
      }
      return;
    }

    const current = this.#intents.get(name);
    if (
      current !== runtime ||
      current.generation !== generation ||
      !current.definition.enabled ||
      this.#closing
    ) {
      await opened.session.close();
      return;
    }

    current.controller = undefined;
    current.session = opened.session;
    current.status = {
      ...current.definition,
      state: "live",
      endpoint: opened.endpoint,
      accessMethod: opened.accessMethod,
    };
    void opened.session.closed.then(
      () => this.#markUnexpectedClosure(name, current, generation),
      (error) => this.#markUnexpectedClosure(name, current, generation, error),
    );
  }

  #markUnexpectedClosure(
    name: string,
    runtime: RuntimeIntent,
    generation: number,
    error?: unknown,
  ): void {
    if (
      this.#closing ||
      this.#intents.get(name) !== runtime ||
      runtime.generation !== generation ||
      !runtime.definition.enabled ||
      runtime.status.state !== "live"
    ) {
      return;
    }
    runtime.session = undefined;
    runtime.status = {
      ...runtime.definition,
      state: "error",
      failure: error === undefined
        ? { code: "provider-unavailable", message: "Endpoint transport closed unexpectedly" }
        : intentFailure(error),
    };
  }
}

function normalizeIntent(request: CreateEndpointIntentRequest): EndpointIntent {
  const name = request.name.trim();
  if (name.length === 0 || name.length > 128) {
    throw new TypeError("Endpoint intent name must be 1-128 characters");
  }
  if (request.instanceId.trim().length === 0) {
    throw new TypeError("Endpoint intent instanceId must be non-empty");
  }
  if (!Number.isInteger(request.remotePort) || request.remotePort < 1 || request.remotePort > 65_535) {
    throw new TypeError("Endpoint intent remotePort must be an integer between 1 and 65535");
  }
  if (request.localPort !== undefined && (!Number.isInteger(request.localPort) || request.localPort < 1 || request.localPort > 65_535)) {
    throw new TypeError("Endpoint intent localPort must be an integer between 1 and 65535");
  }
  const remoteHost = request.remoteHost ?? "127.0.0.1";
  if (remoteHost.trim().length === 0) {
    throw new TypeError("Endpoint intent remoteHost must be non-empty");
  }
  if (request.accessMethodId !== undefined && request.accessMethodId.trim().length === 0) {
    throw new TypeError("Endpoint intent accessMethodId must be non-empty");
  }
  return {
    name,
    enabled: request.enabled ?? true,
    instanceId: request.instanceId,
    remoteHost,
    remotePort: request.remotePort,
    ...(request.localPort === undefined ? {} : { localPort: request.localPort }),
    ...(request.accessMethodId === undefined ? {} : { accessMethodId: request.accessMethodId }),
  };
}

function intentFailure(error: unknown): EndpointIntentFailure {
  if (isHostTrustRequiredError(error)) {
    return {
      code: error.code,
      message: `SSH host trust required for ${error.host}:${error.port}; fingerprint ${error.fingerprint}`,
    };
  }
  if (isNormalizedError(error)) {
    return { code: error.code, message: error.message };
  }
  return { code: "plugin-failure", message: "Endpoint intent realization failed" };
}
