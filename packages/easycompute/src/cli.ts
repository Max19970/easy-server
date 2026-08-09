import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isNormalizedError, type AvailableAction } from "@easycompute/plugin-sdk";
import { ComputeManager } from "./compute-manager.js";
import { ProviderFeatureHost } from "./provider-feature-host.js";
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
  easycompute instances list
  easycompute instances inspect <instance-id>
  easycompute instances start <instance-id>
  easycompute instances stop <instance-id>
  easycompute instances restart <instance-id>
  easycompute instances destroy <instance-id>
  easycompute provider <provider-id> <feature-id> <command> [args...]
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

  if (command === "provider") {
    try {
      await runProvider(args.slice(1));
    } catch (error) {
      process.stderr.write(`${errorMessage(error)}\n\n${help}`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === "instances") {
    try {
      await runInstances(args.slice(1));
    } catch (error) {
      process.stderr.write(`${errorMessage(error)}\n\n${help}`);
      process.exitCode = 1;
    }
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

async function runProvider(args: readonly string[]): Promise<void> {
  const [providerId, featureId, commandName, ...commandArgs] = args;
  const store = new JsonStateStore(stateFilePath());
  const state = await store.read();
  const registry = new ProviderRegistry();
  const featureHost = new ProviderFeatureHost();
  const host = new PluginHost(registry, undefined, featureHost);
  await host.load(
    state.plugins
      .filter((plugin) => plugin.enabled)
      .map((plugin) => canonicalPluginSource(plugin.source)),
  );

  if (providerId === undefined) {
    process.stdout.write(formatProviderFeatures(featureHost.listFeatures()));
    return;
  }

  if (featureId === undefined) {
    process.stdout.write(
      formatProviderFeatures(
        featureHost
          .listFeatures()
          .filter((feature) => feature.providerId === providerId),
      ),
    );
    return;
  }

  const admission = featureHost.acquire(providerId, featureId);
  if (admission === undefined) {
    throw new Error(`Provider Feature not found: ${providerId}/${featureId}`);
  }

  try {
    const commands = admission.feature.cli?.commands ?? [];
    if (commandName === undefined) {
      process.stdout.write(formatProviderCommands(providerId, featureId, commands));
      return;
    }

    const command = commands.find((candidate) => candidate.name === commandName);
    if (command === undefined) {
      throw new Error(
        `Provider command not found: ${providerId}/${featureId}/${commandName}`,
      );
    }

    await command.run(commandArgs, {
      signal: new AbortController().signal,
      write(text) {
        process.stdout.write(text);
      },
      writeError(text) {
        process.stderr.write(text);
      },
    });
  } finally {
    admission.release();
  }
}

async function runInstances(args: readonly string[]): Promise<void> {
  const [command, instanceId] = args;
  const store = new JsonStateStore(stateFilePath());
  const state = await store.read();
  const registry = new ProviderRegistry();
  const host = new PluginHost(registry);
  await host.load(
    state.plugins
      .filter((plugin) => plugin.enabled)
      .map((plugin) => canonicalPluginSource(plugin.source)),
  );
  const manager = new ComputeManager(registry, store);
  const context = { signal: new AbortController().signal };

  if (command === "list" && args.length === 1) {
    const instances = await manager.listInstances(context);
    process.stdout.write(formatInstances(instances));
    return;
  }

  if (command === "inspect" && instanceId !== undefined && args.length === 2) {
    const instance = await manager.inspectInstance(instanceId, context);
    if (instance === undefined) {
      throw new Error(`Compute Instance not found: ${instanceId}`);
    }

    process.stdout.write(`${JSON.stringify(instance, null, 2)}\n`);
    return;
  }

  const action = instanceAction(command);
  if (action !== undefined && instanceId !== undefined && args.length === 2) {
    await manager.performAction(instanceId, action, context);
    process.stdout.write(`Requested ${action} for ${instanceId}\n`);
    return;
  }

  throw new Error(`Unknown instances command: ${command ?? "(missing)"}`);
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
    pluginIndex === index ? { ...plugin, source, enabled } : plugin,
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

function formatProviderFeatures(
  features: readonly import("./provider-feature-host.js").ProviderFeatureDescriptor[],
): string {
  if (features.length === 0) {
    return "No provider features available.\n";
  }

  return `${features
    .map(
      (feature) =>
        `${feature.providerId}/${feature.featureId} ${feature.displayName}`,
    )
    .join("\n")}\n`;
}

function formatProviderCommands(
  providerId: string,
  featureId: string,
  commands: readonly import("@easycompute/plugin-sdk").ProviderCliCommand[],
): string {
  if (commands.length === 0) {
    return `No CLI commands for ${providerId}/${featureId}.\n`;
  }

  return `${commands
    .map((command) => `${command.name.padEnd(12)} ${command.description}`)
    .join("\n")}\n`;
}

function instanceAction(command: string | undefined): AvailableAction | undefined {
  switch (command) {
    case "start":
      return "instance.start";
    case "stop":
      return "instance.stop";
    case "restart":
      return "instance.restart";
    case "destroy":
      return "instance.destroy";
    default:
      return undefined;
  }
}

function formatInstances(instances: readonly import("./compute-manager.js").ComputeInstance[]): string {
  if (instances.length === 0) {
    return "No compute instances found.\n";
  }

  return `${instances
    .map((instance) => {
      const name = instance.name === undefined ? "" : ` name=${JSON.stringify(instance.name)}`;
      const actions = instance.availableActions.length === 0
        ? "-"
        : instance.availableActions.join(",");
      return `${instance.id} provider=${instance.providerId} external=${instance.providerExternalId} state=${instance.state} actions=${actions}${name}`;
    })
    .join("\n")}\n`;
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
  if (isNormalizedError(error)) {
    return `${error.code}: ${error.message}`;
  }

  return error instanceof Error ? error.message : String(error);
}
