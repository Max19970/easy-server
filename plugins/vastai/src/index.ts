import {
  isNormalizedError,
  normalizedError,
  type ProviderAdapter,
  type ProviderInstanceSnapshot,
  type ProviderOperationContext,
  type ProviderPlugin,
} from "@easycompute/plugin-sdk";
import {
  VastApiClient,
  VAST_API_KEY_CREDENTIAL,
  type VastFetch,
} from "./api-client.js";
import {
  createVastMarketplaceFeature,
  type VastMarketplaceFeature,
  type VastOffer,
  type VastOfferSearch,
} from "./marketplace.js";

const DEFAULT_BASE_URL = "https://console.vast.ai";

export { VAST_API_KEY_CREDENTIAL } from "./api-client.js";
export type {
  VastMarketplaceFeature,
  VastOffer,
  VastOfferSearch,
} from "./marketplace.js";

export interface VastPluginOptions {
  readonly baseUrl?: string;
  readonly fetch?: VastFetch;
}

export interface VastProviderPlugin extends ProviderPlugin {
  readonly features: readonly [VastMarketplaceFeature];
}

export function createVastProviderPlugin(
  options: VastPluginOptions = {},
): VastProviderPlugin {
  const client = new VastApiClient(
    options.baseUrl ?? DEFAULT_BASE_URL,
    options.fetch ?? globalThis.fetch,
  );
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
    provider: new VastProviderAdapter(client),
    features: [createVastMarketplaceFeature(client)],
  };
}

class VastProviderAdapter implements ProviderAdapter {
  readonly providerId = "vastai";

  constructor(private readonly client: VastApiClient) {}

  async listInstances(
    context: ProviderOperationContext,
  ): Promise<readonly ProviderInstanceSnapshot[]> {
    const instances: ProviderInstanceSnapshot[] = [];
    const seenTokens = new Set<string>();
    let afterToken: string | undefined;

    for (;;) {
      const url = this.client.url("/api/v1/instances/");
      url.searchParams.set("limit", "25");
      if (afterToken !== undefined) {
        url.searchParams.set("after_token", afterToken);
      }

      const body = await this.client.getJson(url, context);
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
    const body = await this.client.getJson(
      `/api/v0/instances/${encodeURIComponent(providerExternalId)}/`,
      context,
      true,
    );
    if (body === undefined) {
      return undefined;
    }

    const response = expectRecord(body, "Vast.ai instance response");
    return parseInstance(response.instances);
  }
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
