import {
  isNormalizedError,
  normalizedError,
  type ProviderAdapter,
  type ProviderInstanceSnapshot,
  type ProviderOperationContext,
  type ProviderPlugin,
} from "@easycompute/plugin-sdk";

const DEFAULT_BASE_URL = "https://console.vast.ai";
export const VAST_API_KEY_CREDENTIAL = "api-key";

type FetchLike = typeof globalThis.fetch;

export interface VastPluginOptions {
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
}

export function createVastProviderPlugin(
  options: VastPluginOptions = {},
): ProviderPlugin {
  return {
    manifest: {
      id: "vastai",
      displayName: "Vast.ai",
      version: "0.0.0",
      compatibility: {
        easycompute: "*",
        pluginSdk: "*",
      },
      provider: {
        id: "vastai",
        displayName: "Vast.ai",
        capabilities: [],
      },
    },
    provider: new VastProviderAdapter(
      options.baseUrl ?? DEFAULT_BASE_URL,
      options.fetch ?? globalThis.fetch,
    ),
  };
}

class VastProviderAdapter implements ProviderAdapter {
  readonly providerId = "vastai";

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike,
  ) {}

  async listInstances(
    context: ProviderOperationContext,
  ): Promise<readonly ProviderInstanceSnapshot[]> {
    const apiKey = await requireApiKey(context);
    const instances: ProviderInstanceSnapshot[] = [];
    const seenTokens = new Set<string>();
    let afterToken: string | undefined;

    for (;;) {
      const url = new URL("/api/v1/instances/", this.baseUrl);
      url.searchParams.set("limit", "25");
      if (afterToken !== undefined) {
        url.searchParams.set("after_token", afterToken);
      }

      const body = await this.#requestJson(url, apiKey, context);
      const page = parseInstancePage(body);
      instances.push(...page.instances.map(parseInstance));

      if (page.nextToken === undefined) {
        return instances;
      }
      if (seenTokens.has(page.nextToken)) {
        throw normalizedError(
          "plugin-failure",
          "Vast.ai returned a repeated instances pagination token",
        );
      }
      seenTokens.add(page.nextToken);
      afterToken = page.nextToken;
    }
  }

  async getInstance(
    providerExternalId: string,
    context: ProviderOperationContext,
  ): Promise<ProviderInstanceSnapshot | undefined> {
    const apiKey = await requireApiKey(context);
    const url = new URL(
      `/api/v0/instances/${encodeURIComponent(providerExternalId)}/`,
      this.baseUrl,
    );
    const body = await this.#requestJson(url, apiKey, context, true);
    if (body === undefined) {
      return undefined;
    }

    const response = expectRecord(body, "Vast.ai instance response");
    return parseInstance(response.instances);
  }

  async #requestJson(
    url: URL,
    apiKey: string,
    context: ProviderOperationContext,
    allowNotFound = false,
  ): Promise<unknown | undefined> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        signal: context.signal,
      });
    } catch (error) {
      if (context.signal.aborted) {
        throw normalizedError(
          "cancelled",
          "Vast.ai request was cancelled before a response was received",
          error,
        );
      }
      throw normalizedError(
        "provider-unavailable",
        "Vast.ai request failed before a response was received",
        error,
      );
    }

    if (allowNotFound && response.status === 404) {
      return undefined;
    }
    if (response.status === 401 || response.status === 403) {
      throw normalizedError(
        "authentication",
        "Vast.ai rejected the configured API key",
      );
    }
    if (response.status === 429) {
      throw normalizedError("rate-limited", "Vast.ai rate limit exceeded");
    }
    if (response.status >= 500) {
      throw normalizedError(
        "provider-unavailable",
        `Vast.ai returned HTTP ${response.status}`,
      );
    }
    if (!response.ok) {
      throw normalizedError(
        "unknown-provider-error",
        `Vast.ai returned HTTP ${response.status}`,
      );
    }

    try {
      return await response.json();
    } catch (error) {
      throw normalizedError(
        "plugin-failure",
        "Vast.ai returned an invalid JSON response",
        error,
      );
    }
  }
}

async function requireApiKey(context: ProviderOperationContext): Promise<string> {
  const value = await context.resolveCredential(VAST_API_KEY_CREDENTIAL);
  if (value === undefined || value.length === 0) {
    throw normalizedError(
      "authentication",
      `Vast.ai requires configured credential ${VAST_API_KEY_CREDENTIAL}`,
    );
  }
  return value;
}

function parseInstancePage(value: unknown): {
  readonly instances: readonly unknown[];
  readonly nextToken?: string;
} {
  const page = expectRecord(value, "Vast.ai instances response");
  if (!Array.isArray(page.instances)) {
    throw pluginResponseError("Vast.ai instances response.instances must be an array");
  }

  if (page.next_token === null || page.next_token === undefined) {
    return { instances: page.instances };
  }
  if (typeof page.next_token !== "string" || page.next_token.length === 0) {
    throw pluginResponseError(
      "Vast.ai instances response.next_token must be a non-empty string or null",
    );
  }

  return { instances: page.instances, nextToken: page.next_token };
}

function parseInstance(value: unknown): ProviderInstanceSnapshot {
  try {
    const instance = expectRecord(value, "Vast.ai instance");
    if (!Number.isInteger(instance.id) || (instance.id as number) < 0) {
      throw new TypeError("Vast.ai instance.id must be a non-negative integer");
    }
    if (
      instance.actual_status !== null &&
      typeof instance.actual_status !== "string"
    ) {
      throw new TypeError("Vast.ai instance.actual_status must be a string or null");
    }
    if (
      instance.label !== undefined &&
      instance.label !== null &&
      typeof instance.label !== "string"
    ) {
      throw new TypeError("Vast.ai instance.label must be a string or null");
    }

    const rawState = instance.actual_status as string | null;
    const name =
      typeof instance.label === "string" && instance.label.trim().length > 0
        ? instance.label
        : undefined;
    return {
      providerExternalId: String(instance.id),
      state: normalizeInstanceState(rawState),
      rawState,
      availableActions: [],
      ...(name === undefined ? {} : { name }),
    };
  } catch (error) {
    if (isNormalizedError(error)) {
      throw error;
    }
    throw normalizedError(
      "plugin-failure",
      "Vast.ai returned an invalid instance payload",
      error,
    );
  }
}

function normalizeInstanceState(
  status: string | null,
): ProviderInstanceSnapshot["state"] {
  switch (status) {
    case null:
      return "provisioning";
    case "running":
      return "running";
    case "stopped":
      return "stopped";
    case "loading":
    case "rebooting":
      return "starting";
    case "exited":
      return "error";
    default:
      return "unknown";
  }
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw pluginResponseError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function pluginResponseError(message: string): ReturnType<typeof normalizedError> {
  return normalizedError("plugin-failure", message);
}

export default createVastProviderPlugin();
