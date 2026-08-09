import {
  isNormalizedError,
  normalizedError,
  type AccessMethod,
  type PowerAction,
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
import {
  createIntelionServerConfiguratorFeature,
  type IntelionServerConfiguratorFeature,
} from "./configurator.js";

const DEFAULT_BASE_URL = "https://intelion.cloud";
const SSH_PASSWORD_CREDENTIAL = "ssh-password";

export { INTELION_API_TOKEN_CREDENTIAL } from "./api-client.js";
export type {
  IntelionServerConfiguration,
  IntelionServerConfigurationInput,
  IntelionServerConfiguratorFeature,
  IntelionServerCreationResult,
} from "./configurator.js";

export interface IntelionPluginOptions {
  readonly baseUrl?: string;
  readonly fetch?: IntelionFetch;
}

export interface IntelionProviderPlugin extends ProviderPlugin {
  readonly features: readonly [IntelionServerConfiguratorFeature];
}

export function createIntelionProviderPlugin(
  options: IntelionPluginOptions = {},
): IntelionProviderPlugin {
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
        capabilities: [
          "instance.start",
          "instance.stop",
          "instance.restart",
          "instance.destroy",
        ],
      },
    },
    provider: new IntelionProviderAdapter(client),
    features: [createIntelionServerConfiguratorFeature(client)],
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

  async getAccessMethods(
    providerExternalId: string,
    context: ProviderOperationContext,
  ): Promise<readonly AccessMethod[]> {
    const body = await this.client.getJson(
      `/api/v2/cloud-servers/${encodeServerId(providerExternalId)}/`,
      context,
      true,
    );
    if (body === undefined) {
      return [];
    }

    const server = expectRecord(body, "Intelion cloud server");
    const snapshot = parseServer(server);
    if (snapshot.providerExternalId !== providerExternalId || snapshot.rawState !== 2) {
      return [];
    }

    const address = connectionAddress(server);
    const login = server.login;
    if (address === undefined || login === null || login === undefined) {
      return [];
    }
    if (typeof login !== "string" || login.trim().length === 0) {
      return [];
    }

    return [
      {
        id: "ssh",
        kind: "ssh",
        mode: "tcp-forward",
        credentialSources: [
          { kind: "provider-deferred", id: SSH_PASSWORD_CREDENTIAL },
        ],
        ssh: {
          host: address,
          port: 22,
          username: login,
          passwordCredentialId: SSH_PASSWORD_CREDENTIAL,
        },
      },
    ];
  }

  async resolveAccessCredential(
    providerExternalId: string,
    credentialId: string,
    context: ProviderOperationContext,
  ): Promise<string | undefined> {
    if (credentialId !== SSH_PASSWORD_CREDENTIAL) {
      return undefined;
    }
    const body = await this.client.getJson(
      `/api/v2/cloud-servers/${encodeServerId(providerExternalId)}/password/`,
      context,
      true,
    );
    if (body === undefined) {
      return undefined;
    }
    const password =
      typeof body === "string"
        ? body
        : expectRecord(body, "Intelion server password response").password;
    if (typeof password !== "string" || password.length === 0) {
      return undefined;
    }
    return password;
  }

  async performPowerAction(
    providerExternalId: string,
    action: PowerAction,
    context: ProviderOperationContext,
  ): Promise<void> {
    const status =
      action === "instance.start"
        ? 2
        : action === "instance.stop"
          ? -1
          : "REBOOT";
    await this.client.postJsonMutation(
      `/api/v2/cloud-servers/${encodeServerId(providerExternalId)}/actions/`,
      { status },
      context,
    );
  }

  async destroy(
    providerExternalId: string,
    context: ProviderOperationContext,
  ): Promise<void> {
    await this.client.postJsonMutation(
      `/api/v2/cloud-servers/${encodeServerId(providerExternalId)}/actions/`,
      { status: -3 },
      context,
    );
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
      availableActions: availableActions(status),
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

function connectionAddress(server: Record<string, unknown>): string | undefined {
  for (const value of [server.ip_to_connect, server.domain_to_connect]) {
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value !== "string") {
      throw normalizedError(
        "plugin-failure",
        "Intelion connection address must be a string or null",
      );
    }
    if (value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function availableActions(
  status: number,
): ProviderInstanceSnapshot["availableActions"] {
  switch (status) {
    case -3:
      return [];
    case -2:
    case -1:
      return ["instance.start", "instance.destroy"];
    case 2:
      return ["instance.stop", "instance.restart", "instance.destroy"];
    default:
      return ["instance.destroy"];
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
