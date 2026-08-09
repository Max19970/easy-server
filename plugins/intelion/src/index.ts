import {
  isNormalizedError,
  normalizedError,
  type ProviderAdapter,
  type ProviderInstanceSnapshot,
  type ProviderOperationContext,
  type ProviderPlugin,
} from "@easycompute/plugin-sdk";
import {
  IntelionApiClient,
  INTELION_API_TOKEN_CREDENTIAL,
  type IntelionFetch,
} from "./api-client.js";

const DEFAULT_BASE_URL = "https://intelion.cloud";

export { INTELION_API_TOKEN_CREDENTIAL } from "./api-client.js";

export interface IntelionPluginOptions {
  readonly baseUrl?: string;
  readonly fetch?: IntelionFetch;
}

export function createIntelionProviderPlugin(
  options: IntelionPluginOptions = {},
): ProviderPlugin {
  const client = new IntelionApiClient(
    options.baseUrl ?? DEFAULT_BASE_URL,
    options.fetch ?? globalThis.fetch,
  );
  return {
    manifest: {
      id: "intelion",
      displayName: "Intelion.cloud",
      version: "0.0.0",
      compatibility: {
        easycompute: "*",
        pluginSdk: "*",
      },
      provider: {
        id: "intelion",
        displayName: "Intelion.cloud",
        capabilities: [],
      },
    },
    provider: new IntelionProviderAdapter(client),
  };
}

class IntelionProviderAdapter implements ProviderAdapter {
  readonly providerId = "intelion";

  constructor(private readonly client: IntelionApiClient) {}

  async listInstances(
    context: ProviderOperationContext,
  ): Promise<readonly ProviderInstanceSnapshot[]> {
    const instances: ProviderInstanceSnapshot[] = [];
    const seenPages = new Set<string>();
    let page = this.client.url("/api/v2/cloud-servers/");

    for (;;) {
      const pageKey = page.href;
      if (seenPages.has(pageKey)) {
        throw normalizedError(
          "plugin-failure",
          "Intelion returned a repeated cloud-server pagination URL",
        );
      }
      seenPages.add(pageKey);

      const body = await this.client.getJson(page, context);
      const parsed = parseServerPage(body);
      instances.push(...parsed.results.map(parseServer));
      if (parsed.next === undefined) {
        return instances;
      }
      page = this.client.url(parsed.next);
    }
  }

  async getInstance(
    providerExternalId: string,
    context: ProviderOperationContext,
  ): Promise<ProviderInstanceSnapshot | undefined> {
    const body = await this.client.getJson(
      `/api/v2/cloud-servers/${encodeServerId(providerExternalId)}/`,
      context,
      true,
    );
    return body === undefined ? undefined : parseServer(body);
  }
}

function parseServerPage(value: unknown): {
  readonly results: readonly unknown[];
  readonly next?: string;
} {
  try {
    const page = expectRecord(value, "Intelion cloud-server list response");
    if (!Array.isArray(page.results)) {
      throw new TypeError(
        "Intelion cloud-server list response.results must be an array",
      );
    }
    if (page.next === null || page.next === undefined) {
      return { results: page.results };
    }
    if (typeof page.next !== "string" || page.next.length === 0) {
      throw new TypeError(
        "Intelion cloud-server list response.next must be a non-empty string or null",
      );
    }
    return { results: page.results, next: page.next };
  } catch (error) {
    if (isNormalizedError(error)) {
      throw error;
    }
    throw normalizedError(
      "plugin-failure",
      "Intelion returned an invalid cloud-server list payload",
      error,
    );
  }
}

function parseServer(value: unknown): ProviderInstanceSnapshot {
  try {
    const server = expectRecord(value, "Intelion cloud server");
    const id = expectNonNegativeInteger(server.id, "Intelion cloud server.id");
    const status = expectInteger(server.status, "Intelion cloud server.status");
    if (typeof server.name !== "string") {
      throw new TypeError("Intelion cloud server.name must be a string");
    }
    const name = server.name.trim().length === 0 ? undefined : server.name;

    return {
      providerExternalId: String(id),
      state: normalizeServerStatus(status),
      rawState: status,
      availableActions: [],
      ...(name === undefined ? {} : { name }),
    };
  } catch (error) {
    if (isNormalizedError(error)) {
      throw error;
    }
    throw normalizedError(
      "plugin-failure",
      "Intelion returned an invalid cloud-server payload",
      error,
    );
  }
}

function normalizeServerStatus(
  status: number,
): ProviderInstanceSnapshot["state"] {
  switch (status) {
    case -4:
      return "error";
    case -3:
      return "terminated";
    case -2:
      return "provisioning";
    case -1:
      return "stopped";
    case 0:
      return "stopping";
    case 1:
    case 3:
      return "starting";
    case 2:
      return "running";
    default:
      return "unknown";
  }
}

function encodeServerId(value: string): string {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw normalizedError(
      "plugin-failure",
      `Intelion providerExternalId must be a non-negative integer: ${value}`,
    );
  }
  return value;
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectNonNegativeInteger(value: unknown, path: string): number {
  const number = expectInteger(value, path);
  if (number < 0) {
    throw new TypeError(`${path} must be non-negative`);
  }
  return number;
}

function expectInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${path} must be an integer`);
  }
  return value as number;
}

export default createIntelionProviderPlugin();
