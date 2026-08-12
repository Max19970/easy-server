import { isAbsolute, resolve } from "node:path";
import type { PluginCredentialDescriptor } from "@easyai101/easyserver-plugin-sdk";
import {
  removePluginCredential,
  setPluginCredential,
  type CredentialUpdateResult,
} from "./plugin-credentials.js";
import {
  PluginHost,
  type PluginImporter,
  type PluginStatus,
} from "./plugin-host.js";
import { ProviderRegistry } from "./provider-registry.js";
import type { SecretStore } from "./secret-store.js";
import {
  JsonStateStore,
  type PluginRegistration,
} from "./state-store.js";

export interface PluginAddResult {
  readonly source: string;
  readonly pluginId: string;
}

export interface PluginEnabledResult {
  readonly source: string;
  readonly enabled: boolean;
}

export class PluginOperations {
  constructor(
    private readonly stateStore: JsonStateStore,
    private readonly secretStore: SecretStore,
    private readonly pluginImporter?: PluginImporter,
  ) {}

  async list(
    explicitSources: readonly string[] = [],
  ): Promise<readonly PluginStatus[]> {
    const canonicalExplicitSources = explicitSources.map(canonicalPluginSource);
    const explicitSourceSet = new Set(canonicalExplicitSources);
    const state = await this.stateStore.read();
    const configured = configuredPluginLoads(state.plugins);
    const configuredSourceSet = new Set(configured.map((plugin) => plugin.source));
    const host = this.#createIsolatedHost();
    await host.load(
      [
        ...configured,
        ...canonicalExplicitSources.filter(
          (source) => !configuredSourceSet.has(source),
        ),
      ],
      this.secretStore,
    );

    const disabledStatuses: PluginStatus[] = state.plugins
      .filter((plugin) => !plugin.enabled)
      .map((plugin) => canonicalPluginSource(plugin.source))
      .filter((source) => !explicitSourceSet.has(source))
      .map((source) => ({ source, state: "disabled" }));

    return [...host.listPlugins(), ...disabledStatuses];
  }

  async add(rawSource: string): Promise<PluginAddResult> {
    const source = canonicalPluginSource(rawSource);
    let status: PluginStatus | undefined;

    for (;;) {
      const snapshot = await this.stateStore.read();
      if (
        snapshot.plugins.some(
          (plugin) => canonicalPluginSource(plugin.source) === source,
        )
      ) {
        throw new Error(`Plugin source is already configured: ${source}`);
      }

      status = await this.#validateActivation(snapshot.plugins, source);
      let retry = false;
      await this.stateStore.update((state) => {
        if (
          state.plugins.some(
            (plugin) => canonicalPluginSource(plugin.source) === source,
          )
        ) {
          throw new Error(`Plugin source is already configured: ${source}`);
        }
        if (!samePluginActivationInputs(state.plugins, snapshot.plugins)) {
          retry = true;
          return state;
        }
        return {
          ...state,
          plugins: [...state.plugins, { source, enabled: true }],
        };
      });

      if (!retry) {
        break;
      }
    }

    return { source, pluginId: status?.pluginId ?? source };
  }

  async setEnabled(
    rawSource: string,
    enabled: boolean,
  ): Promise<PluginEnabledResult> {
    const source = canonicalPluginSource(rawSource);

    if (!enabled) {
      await this.stateStore.update((state) => {
        const index = findConfiguredPlugin(state.plugins, source);
        if (!state.plugins[index].enabled) {
          return state;
        }
        const plugins = state.plugins.map<PluginRegistration>(
          (plugin, pluginIndex) =>
            pluginIndex === index ? { ...plugin, source, enabled: false } : plugin,
        );
        return { ...state, plugins };
      });
      return { source, enabled: false };
    }

    for (;;) {
      const snapshot = await this.stateStore.read();
      const snapshotIndex = findConfiguredPlugin(snapshot.plugins, source);
      if (snapshot.plugins[snapshotIndex].enabled) {
        break;
      }

      await this.#validateActivation(snapshot.plugins, source);
      let retry = false;
      await this.stateStore.update((state) => {
        const index = findConfiguredPlugin(state.plugins, source);
        if (state.plugins[index].enabled) {
          return state;
        }
        if (!samePluginActivationInputs(state.plugins, snapshot.plugins)) {
          retry = true;
          return state;
        }
        const plugins = state.plugins.map<PluginRegistration>(
          (plugin, pluginIndex) =>
            pluginIndex === index ? { ...plugin, source, enabled: true } : plugin,
        );
        return { ...state, plugins };
      });

      if (!retry) {
        break;
      }
    }

    return { source, enabled: true };
  }

  async credentialDescriptors(
    rawSource: string,
  ): Promise<readonly PluginCredentialDescriptor[] | undefined> {
    const source = canonicalPluginSource(rawSource);
    const state = await this.stateStore.read();
    const index = findConfiguredPlugin(state.plugins, source);
    const registration = state.plugins[index];
    const host = this.#createIsolatedHost();
    await host.load([
      {
        source,
        ...(registration.credentials === undefined
          ? {}
          : { credentials: registration.credentials }),
      },
    ]);
    const status = host.listPlugins()[0];
    if (status?.state !== "loaded" || status.credentials === undefined) {
      return undefined;
    }
    return status.credentials.map(({ configured: _configured, ...descriptor }) =>
      descriptor,
    );
  }

  async setCredential(
    rawSource: string,
    name: string,
    secret: string,
  ): Promise<CredentialUpdateResult> {
    const source = canonicalPluginSource(rawSource);
    return setPluginCredential(
      this.stateStore,
      this.secretStore,
      source,
      name,
      secret,
      await this.credentialDescriptors(source),
    );
  }

  async removeCredential(
    rawSource: string,
    name: string,
  ): Promise<CredentialUpdateResult> {
    const source = canonicalPluginSource(rawSource);
    return removePluginCredential(
      this.stateStore,
      this.secretStore,
      source,
      name,
      await this.credentialDescriptors(source),
    );
  }

  async #validateActivation(
    plugins: readonly PluginRegistration[],
    source: string,
  ): Promise<PluginStatus> {
    const configured = configuredPluginLoads(plugins).filter(
      (plugin) => plugin.source !== source,
    );
    const host = this.#createIsolatedHost();
    await host.load([...configured, source]);
    const status = host.listPlugins().at(-1);

    if (status?.state !== "loaded") {
      throw new Error(status?.error ?? `Failed to load plugin: ${source}`);
    }

    return status;
  }

  #createIsolatedHost(): PluginHost {
    return new PluginHost(new ProviderRegistry(), this.pluginImporter);
  }
}

function findConfiguredPlugin(
  plugins: readonly PluginRegistration[],
  source: string,
): number {
  const index = plugins.findIndex(
    (plugin) => canonicalPluginSource(plugin.source) === source,
  );
  if (index < 0) {
    throw new Error(`Plugin source is not configured: ${source}`);
  }
  return index;
}

function samePluginActivationInputs(
  current: readonly PluginRegistration[],
  snapshot: readonly PluginRegistration[],
): boolean {
  const currentEnabled = current
    .filter((plugin) => plugin.enabled)
    .map((plugin) => canonicalPluginSource(plugin.source));
  const snapshotEnabled = snapshot
    .filter((plugin) => plugin.enabled)
    .map((plugin) => canonicalPluginSource(plugin.source));
  return (
    currentEnabled.length === snapshotEnabled.length &&
    currentEnabled.every((source, index) => source === snapshotEnabled[index])
  );
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
      source: canonicalPluginSource(plugin.source),
      ...(plugin.credentials === undefined
        ? {}
        : { credentials: plugin.credentials }),
    }));
}

function canonicalPluginSource(source: string): string {
  return isPathSpecifier(source) ? resolve(source) : source;
}

function isPathSpecifier(source: string): boolean {
  return (
    isAbsolute(source) ||
    source.startsWith("./") ||
    source.startsWith("../") ||
    source.startsWith(".\\") ||
    source.startsWith("..\\")
  );
}
