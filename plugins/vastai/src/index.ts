import {
  isNormalizedError,
  normalizedError,
  type ProviderAdapter,
  type ProviderInstanceSnapshot,
  type AccessMethod,
  type PowerAction,
  type ProviderOperationContext,
  type ProviderPlugin,
} from "@easyai101/easyserver-plugin-sdk";
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
  VastRentalRequest,
  VastRentalResult,
  VastRuntype,
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
      version: "0.2.2",
      compatibility: {
        easyserver: "^0.2.0",
        pluginSdk: "^0.2.0",
      },
      credentials: [
        {
          name: VAST_API_KEY_CREDENTIAL,
          required: true,
          description: "Vast.ai API key",
        },
      ],
      provider: {
        id: "vastai",
        displayName: "Vast.ai",
        capabilities: [
          "instance.start",
          "instance.stop",
          "instance.restart",
          "instance.destroy",
        ],
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
    const instance = expectOptionalInstanceRecord(response.instances);
    return instance === undefined ? undefined : parseInstance(instance);
  }

  async getAccessMethods(
    providerExternalId: string,
    context: ProviderOperationContext,
  ): Promise<readonly AccessMethod[]> {
    const body = await this.client.getJson(
      `/api/v0/instances/${encodeInstanceId(providerExternalId)}/`,
      context,
      true,
    );
    if (body === undefined) {
      return [];
    }

    const response = expectRecord(body, "Vast.ai instance response");
    const instance = expectOptionalInstanceRecord(response.instances);
    if (instance === undefined) {
      return [];
    }
    const snapshot = parseInstance(instance);
    if (snapshot.providerExternalId !== providerExternalId) {
      throw normalizedError(
        "plugin-failure",
        `Vast.ai returned instance ${snapshot.providerExternalId} for requested ${providerExternalId}`,
      );
    }
    if (snapshot.state !== "running") {
      return [];
    }

    const host = instance.ssh_host;
    const port = instance.ssh_port;
    if (host === null || host === undefined || port === null || port === undefined) {
      return [];
    }
    if (typeof host !== "string" || host.trim().length === 0) {
      throw pluginResponseError("Vast.ai instance.ssh_host must be a non-empty string or null");
    }
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535) {
      throw pluginResponseError(
        "Vast.ai instance.ssh_port must be an integer between 1 and 65535 or null",
      );
    }

    return [
      {
        id: "ssh",
        kind: "ssh",
        mode: "tcp-forward",
        ssh: {
          host,
          port: port as number,
          username: "root",
        },
      },
    ];
  }

  async performPowerAction(
    providerExternalId: string,
    action: PowerAction,
    context: ProviderOperationContext,
  ): Promise<void> {
    const id = encodeInstanceId(providerExternalId);
    const response =
      action === "instance.restart"
        ? await this.client.putMutation(
            `/api/v0/instances/reboot/${id}/`,
            context,
            "conflict",
          )
        : await this.client.putJsonMutation(
            `/api/v0/instances/${id}/`,
            { state: action === "instance.start" ? "running" : "stopped" },
            context,
            "conflict",
          );
    assertMutationSuccess(response, `Vast.ai ${action} response`);
  }

  async destroy(
    providerExternalId: string,
    context: ProviderOperationContext,
  ): Promise<void> {
    const response = await this.client.deleteMutation(
      `/api/v0/instances/${encodeInstanceId(providerExternalId)}/`,
      context,
      "conflict",
    );
    assertMutationSuccess(response, "Vast.ai destroy response");
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
      instance.intended_status !== undefined &&
      instance.intended_status !== null &&
      typeof instance.intended_status !== "string"
    ) {
      throw new TypeError(
        "Vast.ai instance.intended_status must be a string or null",
      );
    }
    if (
      instance.cur_state !== undefined &&
      instance.cur_state !== null &&
      typeof instance.cur_state !== "string"
    ) {
      throw new TypeError("Vast.ai instance.cur_state must be a string or null");
    }
    if (
      instance.label !== undefined &&
      instance.label !== null &&
      typeof instance.label !== "string"
    ) {
      throw new TypeError("Vast.ai instance.label must be a string or null");
    }

    const rawState = instance.actual_status as string | null;
    const lifecycleState =
      instance.intended_status === "stopped" && instance.cur_state === "stopped"
        ? "stopped"
        : rawState;
    const name =
      typeof instance.label === "string" && instance.label.trim().length > 0
        ? instance.label
        : undefined;
    return {
      providerExternalId: String(instance.id),
      state: normalizeInstanceState(lifecycleState),
      rawState,
      availableActions: availableActions(lifecycleState),
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

function availableActions(
  status: string | null,
): ProviderInstanceSnapshot["availableActions"] {
  switch (status) {
    case "running":
      return ["instance.stop", "instance.restart", "instance.destroy"];
    case "stopped":
      return ["instance.start", "instance.destroy"];
    default:
      return ["instance.destroy"];
  }
}

function encodeInstanceId(value: string): string {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw normalizedError(
      "plugin-failure",
      `Vast.ai providerExternalId must be a non-negative integer: ${value}`,
    );
  }
  return value;
}

function assertMutationSuccess(value: unknown, path: string): void {
  let response: Record<string, unknown>;
  try {
    response = expectRecord(value, path);
  } catch (error) {
    throw normalizedError(
      "outcome-unknown",
      `${path} is ambiguous after mutation dispatch`,
      error,
    );
  }
  if (response.success !== true) {
    throw normalizedError(
      "outcome-unknown",
      `${path}.success did not confirm the mutation result`,
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

function expectOptionalInstanceRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (value === null || (Array.isArray(value) && value.length === 0)) {
    return undefined;
  }
  return expectRecord(value, "Vast.ai instance");
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
