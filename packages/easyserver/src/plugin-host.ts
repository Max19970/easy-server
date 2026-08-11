import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { satisfies, validRange } from "semver";
import {
  normalizedError,
  parseProviderPlugin,
  PLUGIN_SDK_VERSION,
  type AccessAdapter,
  type ProviderFeature,
  type ProviderPlugin,
  type SecretReference,
} from "@easyai101/easyserver-plugin-sdk";
import {
  ProviderFeatureHost,
  type ProviderFeatureAdmission,
} from "./provider-feature-host.js";
import {
  ProviderRegistry,
  type ProviderAdmission,
} from "./provider-registry.js";
import type { SecretStore } from "./secret-store.js";
import { escapeTerminalText } from "./terminal-text.js";
import { EASYSERVER_VERSION } from "./version.js";

const DEFAULT_PLUGIN_LOAD_TIMEOUT_MS = 10_000;

export type PluginState = "loaded" | "disabled" | "failed";

export interface PluginStatus {
  readonly source: string;
  readonly state: PluginState;
  readonly pluginId?: string;
  readonly displayName?: string;
  readonly version?: string;
  readonly providerId?: string;
  readonly error?: string;
}

export type PluginImporter = (source: string) => Promise<unknown>;

export interface PluginLoadCredential {
  readonly name: string;
  readonly secretRef: SecretReference;
}

export interface PluginLoadRequest {
  readonly source: string;
  readonly credentials?: readonly PluginLoadCredential[];
}

export type PluginLoadSource = string | PluginLoadRequest;

type PluginRecord =
  | { readonly source: string; readonly runtime: PluginRuntime }
  | { readonly source: string; readonly error: string };

export class PluginHost {
  readonly #registry: ProviderRegistry;
  readonly #featureHost: ProviderFeatureHost;
  readonly #importer: PluginImporter;
  readonly #loadTimeoutMs: number;
  readonly #records: PluginRecord[] = [];
  readonly #runtimes = new Map<string, PluginRuntime>();

  constructor(
    registry: ProviderRegistry,
    importer: PluginImporter = importProviderPlugin,
    featureHost: ProviderFeatureHost = new ProviderFeatureHost(),
    loadTimeoutMs = DEFAULT_PLUGIN_LOAD_TIMEOUT_MS,
  ) {
    if (!Number.isFinite(loadTimeoutMs) || loadTimeoutMs <= 0) {
      throw new TypeError("loadTimeoutMs must be a positive finite number");
    }

    this.#registry = registry;
    this.#importer = importer;
    this.#featureHost = featureHost;
    this.#loadTimeoutMs = loadTimeoutMs;
  }

  async load(
    sources: readonly PluginLoadSource[],
    secretStore?: Pick<SecretStore, "get">,
  ): Promise<void> {
    for (const candidate of sources) {
      const request =
        typeof candidate === "string" ? { source: candidate } : candidate;
      await this.#loadOne(request, secretStore);
    }
  }

  listPlugins(): readonly PluginStatus[] {
    return this.#records.map((record) => {
      if ("error" in record) {
        return {
          source: record.source,
          state: "failed",
          error: record.error,
        };
      }

      return record.runtime.status(record.source);
    });
  }

  disable(pluginId: string): boolean {
    const runtime = this.#runtimes.get(pluginId);

    if (runtime === undefined || !runtime.disable()) {
      return false;
    }

    this.#registry.unregister(runtime.providerId, runtime.pluginId);
    this.#featureHost.unregisterPlugin(runtime.pluginId);
    return true;
  }

  async #loadOne(
    request: PluginLoadRequest,
    secretStore?: Pick<SecretStore, "get">,
  ): Promise<void> {
    const { source } = request;
    try {
      const imported = await withTimeout(
        this.#importer(source),
        this.#loadTimeoutMs,
        `Plugin load timed out after ${this.#loadTimeoutMs} ms: ${source}`,
      );
      const plugin = parseProviderPlugin(imported);
      assertCompatibility(plugin);

      if (this.#runtimes.has(plugin.manifest.id)) {
        throw new Error(`Plugin already loaded: ${plugin.manifest.id}`);
      }

      const runtime = new PluginRuntime(
        plugin,
        request.credentials ?? [],
        secretStore,
      );
      this.#registry.register(
        runtime.providerId,
        runtime.pluginId,
        () => runtime.admit(),
      );

      try {
        for (const feature of runtime.features) {
          this.#featureHost.register(
            {
              pluginId: runtime.pluginId,
              providerId: runtime.providerId,
              featureId: feature.id,
              displayName: feature.displayName,
            },
            () => runtime.admitFeature(feature.id),
          );
        }
      } catch (error) {
        this.#featureHost.unregisterPlugin(runtime.pluginId);
        this.#registry.unregister(runtime.providerId, runtime.pluginId);
        throw error;
      }

      this.#runtimes.set(runtime.pluginId, runtime);
      this.#records.push({ source, runtime });
    } catch (error) {
      this.#records.push({ source, error: errorMessage(error) });
    }
  }
}

class PluginRuntime {
  readonly pluginId: string;
  readonly providerId: string;
  readonly features: readonly ProviderFeature[];
  readonly accessAdapters: readonly AccessAdapter[];
  readonly #plugin: ProviderPlugin;
  readonly #credentials: ReadonlyMap<string, SecretReference>;
  readonly #secretStore?: Pick<SecretStore, "get">;
  #admitting = true;

  constructor(
    plugin: ProviderPlugin,
    credentials: readonly PluginLoadCredential[],
    secretStore?: Pick<SecretStore, "get">,
  ) {
    this.#plugin = plugin;
    this.pluginId = plugin.manifest.id;
    this.providerId = plugin.manifest.provider.id;
    this.features = plugin.features ?? [];
    this.accessAdapters = plugin.accessAdapters ?? [];
    this.#credentials = credentialMap(credentials);
    this.#secretStore = secretStore;
  }

  admit(): ProviderAdmission | undefined {
    if (!this.#admitting) {
      return undefined;
    }

    const provider = this.#plugin.provider;
    return {
      pluginId: this.pluginId,
      provider,
      capabilities: this.#plugin.manifest.provider.capabilities,
      accessAdapters: this.accessAdapters,
      resolveCredential: (name, signal) => this.#resolveCredential(name, signal),
      release() {},
    };
  }

  admitFeature(featureId: string): ProviderFeatureAdmission | undefined {
    if (!this.#admitting) {
      return undefined;
    }

    const feature = this.features.find((candidate) => candidate.id === featureId);
    if (feature === undefined) {
      return undefined;
    }

    return {
      pluginId: this.pluginId,
      providerId: this.providerId,
      featureId: feature.id,
      displayName: feature.displayName,
      feature,
      resolveCredential: (name, signal) => this.#resolveCredential(name, signal),
      release() {},
    };
  }

  async #resolveCredential(
    name: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const ref = this.#credentials.get(name);
    if (ref === undefined) {
      return undefined;
    }
    if (this.#secretStore === undefined) {
      throw normalizedError(
        "authentication",
        `No Secret Store is configured for provider credential ${name}`,
      );
    }
    return this.#secretStore.get(ref, signal);
  }

  disable(): boolean {
    if (!this.#admitting) {
      return false;
    }

    this.#admitting = false;
    return true;
  }

  status(source: string): PluginStatus {
    return {
      source,
      state: this.#admitting ? "loaded" : "disabled",
      pluginId: this.pluginId,
      displayName: this.#plugin.manifest.displayName,
      version: this.#plugin.manifest.version,
      providerId: this.providerId,
    };
  }
}

export function formatPluginStatuses(
  statuses: readonly PluginStatus[],
): string {
  if (statuses.length === 0) {
    return "No provider plugins configured.\n";
  }

  return `${statuses
    .map((status) => {
      const label = escapeTerminalText(status.pluginId ?? status.source);
      const provider = status.providerId === undefined
        ? ""
        : ` provider=${escapeTerminalText(status.providerId)}`;
      const error = status.error === undefined
        ? ""
        : ` error=${escapeTerminalText(status.error)}`;
      return `${status.state.padEnd(8)} ${label}${provider}${error}`;
    })
    .join("\n")}\n`;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function importProviderPlugin(source: string): Promise<unknown> {
  const specifier = isPathSpecifier(source)
    ? pathToFileURL(resolve(source)).href
    : source;
  const module = (await import(specifier)) as { readonly default?: unknown };

  if (!("default" in module)) {
    throw new Error(`Plugin module has no default export: ${source}`);
  }

  return module.default;
}

function isPathSpecifier(source: string): boolean {
  return isAbsolute(source) || source.startsWith("./") || source.startsWith("../");
}

function assertCompatibility(plugin: ProviderPlugin): void {
  const { compatibility } = plugin.manifest;

  if (!acceptsVersion(compatibility.easyserver, EASYSERVER_VERSION)) {
    throw new Error(
      `Plugin ${plugin.manifest.id} requires EasyServer ${compatibility.easyserver}; current version is ${EASYSERVER_VERSION}`,
    );
  }

  if (!acceptsVersion(compatibility.pluginSdk, PLUGIN_SDK_VERSION)) {
    throw new Error(
      `Plugin ${plugin.manifest.id} requires plugin SDK ${compatibility.pluginSdk}; current version is ${PLUGIN_SDK_VERSION}`,
    );
  }
}

function acceptsVersion(requirement: string, version: string): boolean {
  return validRange(requirement) !== null && satisfies(version, requirement);
}

function credentialMap(
  credentials: readonly PluginLoadCredential[],
): ReadonlyMap<string, SecretReference> {
  const result = new Map<string, SecretReference>();
  for (const credential of credentials) {
    if (result.has(credential.name)) {
      throw new Error(`Duplicate plugin credential name: ${credential.name}`);
    }
    result.set(credential.name, credential.secretRef);
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
