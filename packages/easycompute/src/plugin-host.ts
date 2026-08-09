import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseProviderPlugin,
  type ProviderPlugin,
} from "@easycompute/plugin-sdk";
import {
  ProviderRegistry,
  type ProviderAdmission,
} from "./provider-registry.js";

const EASYCMP_VERSION = "0.0.0";
const PLUGIN_SDK_VERSION = "0.0.0";

export type PluginState = "loaded" | "disabled" | "failed";

export interface PluginStatus {
  readonly source: string;
  readonly state: PluginState;
  readonly pluginId?: string;
  readonly displayName?: string;
  readonly providerId?: string;
  readonly error?: string;
}

export type PluginImporter = (source: string) => Promise<unknown>;

type PluginRecord =
  | { readonly source: string; readonly runtime: PluginRuntime }
  | { readonly source: string; readonly error: string };

export class PluginHost {
  readonly #registry: ProviderRegistry;
  readonly #importer: PluginImporter;
  readonly #records: PluginRecord[] = [];
  readonly #runtimes = new Map<string, PluginRuntime>();

  constructor(
    registry: ProviderRegistry,
    importer: PluginImporter = importProviderPlugin,
  ) {
    this.#registry = registry;
    this.#importer = importer;
  }

  async load(sources: readonly string[]): Promise<void> {
    for (const source of sources) {
      await this.#loadOne(source);
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
    return true;
  }

  async #loadOne(source: string): Promise<void> {
    try {
      const plugin = parseProviderPlugin(await this.#importer(source));
      assertCompatibility(plugin);

      if (this.#runtimes.has(plugin.manifest.id)) {
        throw new Error(`Plugin already loaded: ${plugin.manifest.id}`);
      }

      const runtime = new PluginRuntime(plugin);
      this.#registry.register(
        runtime.providerId,
        runtime.pluginId,
        () => runtime.admit(),
      );
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
  readonly #plugin: ProviderPlugin;
  #admitting = true;

  constructor(plugin: ProviderPlugin) {
    this.#plugin = plugin;
    this.pluginId = plugin.manifest.id;
    this.providerId = plugin.manifest.provider.id;
  }

  admit(): ProviderAdmission | undefined {
    if (!this.#admitting) {
      return undefined;
    }

    const provider = this.#plugin.provider;
    return {
      pluginId: this.pluginId,
      provider,
      release() {},
    };
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
      const label = status.pluginId ?? status.source;
      const provider = status.providerId === undefined ? "" : ` provider=${status.providerId}`;
      const error = status.error === undefined ? "" : ` error=${status.error}`;
      return `${status.state.padEnd(8)} ${label}${provider}${error}`;
    })
    .join("\n")}\n`;
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

  if (!acceptsVersion(compatibility.easycompute, EASYCMP_VERSION)) {
    throw new Error(
      `Plugin ${plugin.manifest.id} requires EasyCompute ${compatibility.easycompute}; current version is ${EASYCMP_VERSION}`,
    );
  }

  if (!acceptsVersion(compatibility.pluginSdk, PLUGIN_SDK_VERSION)) {
    throw new Error(
      `Plugin ${plugin.manifest.id} requires plugin SDK ${compatibility.pluginSdk}; current version is ${PLUGIN_SDK_VERSION}`,
    );
  }
}

function acceptsVersion(requirement: string, version: string): boolean {
  // ponytail: pre-release compatibility accepts exact versions or "*"; use a SemVer range library when published plugin ranges are required.
  return requirement === "*" || requirement === version;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
