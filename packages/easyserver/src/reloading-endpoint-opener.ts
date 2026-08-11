import { normalizedError, type OperationContext } from "@easyai101/easyserver-plugin-sdk";
import { AccessAdapterRegistry } from "./access-adapter-registry.js";
import {
  ConnectionGateway,
  type OpenEndpointResult,
} from "./connection-gateway.js";
import { PluginHost, type PluginStatus } from "./plugin-host.js";
import { ProviderRegistry } from "./provider-registry.js";
import type { SecretStore } from "./secret-store.js";
import {
  JsonStateStore,
  type EasyServerState,
  type PluginRegistration,
} from "./state-store.js";

interface RuntimeGeneration {
  readonly fingerprint: string;
  readonly gateway: ConnectionGateway;
  readonly providerIds: ReadonlySet<string>;
  readonly pluginStatuses: readonly PluginStatus[];
}

export class ReloadingEndpointOpener {
  #generation: RuntimeGeneration | undefined;
  #refresh: Promise<RuntimeGeneration> | undefined;

  constructor(
    private readonly stateStore: JsonStateStore,
    private readonly secretStore: SecretStore,
  ) {}

  async openEndpoint(
    instanceId: string,
    remotePort: number,
    remoteHost: string,
    context: OperationContext,
    localPort?: number,
    accessMethodId?: string,
  ): Promise<OpenEndpointResult> {
    for (;;) {
      const state = await this.stateStore.read();
      const binding = state.instances?.find((candidate) => candidate.id === instanceId);
      if (binding === undefined) {
        throw normalizedError("not-found", `Compute Instance not found: ${instanceId}`);
      }

      const generation = await this.#currentGeneration(state);
      const current = await this.stateStore.read();
      if (
        pluginConfigurationFingerprint(current.plugins) !== generation.fingerprint
      ) {
        continue;
      }

      if (!generation.providerIds.has(binding.providerId)) {
        const failed = generation.pluginStatuses.some(
          (status) => status.state === "failed",
        );
        if (failed) {
          throw normalizedError(
            "plugin-failure",
            `Provider ${binding.providerId} is unavailable because the current plugin configuration failed to reload`,
          );
        }
      }

      return generation.gateway.openEndpoint(
        instanceId,
        remotePort,
        remoteHost,
        context,
        localPort,
        accessMethodId,
      );
    }
  }

  async #currentGeneration(state: EasyServerState): Promise<RuntimeGeneration> {
    let fingerprint = pluginConfigurationFingerprint(state.plugins);
    for (;;) {
      if (this.#generation?.fingerprint === fingerprint) {
        return this.#generation;
      }

      this.#refresh ??= this.#buildStableGeneration().finally(() => {
        this.#refresh = undefined;
      });
      const generation = await this.#refresh;
      this.#generation = generation;
      if (generation.fingerprint === fingerprint) {
        return generation;
      }

      fingerprint = pluginConfigurationFingerprint(
        (await this.stateStore.read()).plugins,
      );
    }
  }

  async #buildStableGeneration(): Promise<RuntimeGeneration> {
    for (;;) {
      const before = await this.stateStore.read();
      const fingerprint = pluginConfigurationFingerprint(before.plugins);
      const registry = new ProviderRegistry();
      const host = new PluginHost(registry);
      await host.load(configuredPluginLoads(before.plugins), this.secretStore);
      const after = await this.stateStore.read();
      if (pluginConfigurationFingerprint(after.plugins) !== fingerprint) {
        continue;
      }

      return {
        fingerprint,
        gateway: new ConnectionGateway(
          registry,
          new AccessAdapterRegistry(),
          this.stateStore,
          this.secretStore,
        ),
        providerIds: new Set(registry.listProviderIds()),
        pluginStatuses: host.listPlugins(),
      };
    }
  }
}

function configuredPluginLoads(
  plugins: readonly PluginRegistration[],
): readonly {
  readonly source: string;
  readonly credentials?: PluginRegistration["credentials"];
}[] {
  return plugins
    .filter((plugin) => plugin.enabled)
    .map((plugin) => ({
      source: plugin.source,
      ...(plugin.credentials === undefined ? {} : { credentials: plugin.credentials }),
    }));
}

function pluginConfigurationFingerprint(
  plugins: readonly PluginRegistration[],
): string {
  return JSON.stringify(
    plugins.map((plugin) => ({
      source: plugin.source,
      enabled: plugin.enabled,
      credentials:
        plugin.credentials?.map((credential) => ({
          name: credential.name,
          secretRef: credential.secretRef,
        })) ?? [],
    })),
  );
}
