import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  formatPluginStatuses,
  PluginHost,
  type PluginStatus,
} from "./plugin-host.js";
import { ProviderRegistry } from "./provider-registry.js";
import { JsonStateStore, type PluginRegistration } from "./state-store.js";

const VERSION = "0.0.0";

const help = `EasyCompute

Usage:
  easycompute --help
  easycompute --version
  easycompute plugins list [--plugin <module> ...]
  easycompute plugins add <module>
  easycompute plugins enable <module>
  easycompute plugins disable <module>
`;

await run(process.argv.slice(2));

async function run(args: readonly string[]): Promise<void> {
  const [command] = args;

  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(help);
    return;
  }

  if (command === "--version" || command === "-v" || command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (command === "plugins") {
    try {
      await runPlugins(args.slice(1));
    } catch (error) {
      process.stderr.write(`${errorMessage(error)}\n\n${help}`);
      process.exitCode = 1;
    }
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n\n${help}`);
  process.exitCode = 1;
}

async function runPlugins(args: readonly string[]): Promise<void> {
  const [command] = args;
  const store = new JsonStateStore(stateFilePath());

  if (command === "list") {
    await listPlugins(store, parsePluginSources(args.slice(1)));
    return;
  }

  if (command === "add" && args.length === 2) {
    await addPlugin(store, persistedPluginSource(args[1]));
    return;
  }

  if ((command === "enable" || command === "disable") && args.length === 2) {
    await setPluginEnabled(store, persistedPluginSource(args[1]), command === "enable");
    return;
  }

  throw new Error(`Unknown plugins command: ${command ?? "(missing)"}`);
}

async function listPlugins(
  store: JsonStateStore,
  explicitSources: readonly string[],
): Promise<void> {
  const canonicalExplicitSources = explicitSources.map(canonicalPluginSource);
  const explicitSourceSet = new Set(canonicalExplicitSources);
  const state = await store.read();
  const configuredSources = state.plugins
    .filter((plugin) => plugin.enabled)
    .map((plugin) => canonicalPluginSource(plugin.source));
  const registry = new ProviderRegistry();
  const host = new PluginHost(registry);
  await host.load([
    ...new Set([...configuredSources, ...canonicalExplicitSources]),
  ]);

  const disabledStatuses: PluginStatus[] = state.plugins
    .filter((plugin) => !plugin.enabled)
    .map((plugin) => canonicalPluginSource(plugin.source))
    .filter((source) => !explicitSourceSet.has(source))
    .map((source) => ({ source, state: "disabled" }));

  process.stdout.write(
    formatPluginStatuses([...host.listPlugins(), ...disabledStatuses]),
  );
}

async function addPlugin(store: JsonStateStore, source: string): Promise<void> {
  const state = await store.read();

  if (
    state.plugins.some(
      (plugin) => canonicalPluginSource(plugin.source) === source,
    )
  ) {
    throw new Error(`Plugin source is already configured: ${source}`);
  }

  const status = await validatePluginActivation(state.plugins, source);
  await store.write({
    ...state,
    plugins: [...state.plugins, { source, enabled: true }],
  });
  process.stdout.write(`Added ${status.pluginId ?? source}\n`);
}

async function setPluginEnabled(
  store: JsonStateStore,
  source: string,
  enabled: boolean,
): Promise<void> {
  const state = await store.read();
  const index = state.plugins.findIndex(
    (plugin) => canonicalPluginSource(plugin.source) === source,
  );

  if (index < 0) {
    throw new Error(`Plugin source is not configured: ${source}`);
  }

  if (state.plugins[index].enabled === enabled) {
    process.stdout.write(`${enabled ? "Enabled" : "Disabled"} ${source}\n`);
    return;
  }

  if (enabled) {
    await validatePluginActivation(state.plugins, source);
  }

  const plugins = state.plugins.map<PluginRegistration>((plugin, pluginIndex) =>
    pluginIndex === index ? { source, enabled } : plugin,
  );
  await store.write({ ...state, plugins });
  process.stdout.write(`${enabled ? "Enabled" : "Disabled"} ${source}\n`);
}

async function validatePluginActivation(
  plugins: readonly PluginRegistration[],
  source: string,
): Promise<PluginStatus> {
  const configuredSources = plugins
    .filter(
      (plugin) =>
        plugin.enabled && canonicalPluginSource(plugin.source) !== source,
    )
    .map((plugin) => canonicalPluginSource(plugin.source));
  const host = new PluginHost(new ProviderRegistry());
  await host.load([...new Set([...configuredSources, source])]);
  const status = host.listPlugins().at(-1);

  if (status?.state !== "loaded") {
    throw new Error(status?.error ?? `Failed to load plugin: ${source}`);
  }

  return status;
}

function parsePluginSources(args: readonly string[]): readonly string[] {
  const sources: string[] = [];

  for (let index = 0; index < args.length; index += 2) {
    if (args[index] !== "--plugin" || args[index + 1] === undefined) {
      throw new Error("plugins list accepts only --plugin <module> pairs");
    }

    sources.push(args[index + 1]);
  }

  return sources;
}

function persistedPluginSource(source: string): string {
  return canonicalPluginSource(source);
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

function stateFilePath(): string {
  return (
    process.env.EASYCOMPUTE_STATE_FILE ??
    join(homedir(), ".easycompute", "state.json")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
