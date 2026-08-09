import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  isNormalizedError,
  type AvailableAction,
  type HostTrustRequiredError,
} from "@easycompute/plugin-sdk";
import { AccessAdapterRegistry } from "./access-adapter-registry.js";
import { runForegroundConnect } from "./connect-command.js";
import { ConnectionGateway } from "./connection-gateway.js";
import { ComputeManager } from "./compute-manager.js";
import { ProviderFeatureHost } from "./provider-feature-host.js";
import {
  formatPluginStatuses,
  PluginHost,
  type PluginStatus,
} from "./plugin-host.js";
import {
  removePluginCredential,
  setPluginCredential,
} from "./plugin-credentials.js";
import { ProviderRegistry } from "./provider-registry.js";
import { OsKeyringSecretStore } from "./secret-store.js";
import { OpenSshAccessAdapter } from "./ssh-access-adapter.js";
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
  easycompute plugins credential set <module> <name> --env <variable>
  easycompute plugins credential remove <module> <name>
  easycompute instances list
  easycompute instances inspect <instance-id>
  easycompute instances start <instance-id>
  easycompute instances stop <instance-id>
  easycompute instances restart <instance-id>
  easycompute instances destroy <instance-id>
  easycompute connect <instance-id> --port <remote-port> [--host <remote-host>]
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

  if (command === "connect") {
    try {
      await runConnect(args.slice(1));
    } catch (error) {
      process.stderr.write(`${errorMessage(error)}\n\n${help}`);
      process.exitCode = 1;
    }
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

async function runConnect(args: readonly string[]): Promise<void> {
  const { instanceId, remotePort, remoteHost } = parseConnectArgs(args);
  const store = new JsonStateStore(stateFilePath());
  const state = await store.read();
  const registry = new ProviderRegistry();
  const secretStore = new OsKeyringSecretStore();
  const host = new PluginHost(registry);
  await host.load(configuredPluginLoads(state.plugins), secretStore);

  const sshAdapter = new OpenSshAccessAdapter();
  const accessAdapters = new AccessAdapterRegistry([sshAdapter]);
  const gateway = new ConnectionGateway(
    registry,
    accessAdapters,
    store,
    secretStore,
  );
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);

  try {
    await runForegroundConnect({
      gateway,
      sshAdapter,
      instanceId,
      remotePort,
      remoteHost,
      context: { signal: controller.signal },
      ...(process.stdin.isTTY && process.stdout.isTTY
        ? { confirmHostTrust: confirmHostTrustInteractively }
        : {}),
      onEndpoint(endpoint) {
        process.stdout.write(`${endpoint.host}:${endpoint.port}\n`);
      },
    });
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

async function confirmHostTrustInteractively(
  trust: HostTrustRequiredError,
  signal: AbortSignal,
): Promise<boolean> {
  process.stdout.write(
    `Unknown SSH host ${trust.host}:${trust.port}\n${trust.keyType} fingerprint: ${trust.fingerprint}\n`,
  );
  const readline = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const answer = await readline.question(
      'Trust this host? Type "yes" to continue: ',
      { signal },
    );
    return answer.trim().toLowerCase() === "yes";
  } catch (error) {
    if (signal.aborted) {
      return false;
    }
    throw error;
  } finally {
    readline.close();
  }
}

function parseConnectArgs(args: readonly string[]): {
  readonly instanceId: string;
  readonly remotePort: number;
  readonly remoteHost?: string;
} {
  const [instanceId, ...options] = args;
  if (instanceId === undefined || instanceId.trim().length === 0) {
    throw new Error("connect requires <instance-id>");
  }

  let remotePort: number | undefined;
  let remoteHost: string | undefined;

  for (let index = 0; index < options.length; index += 2) {
    const option = options[index];
    const value = options[index + 1];
    if (value === undefined) {
      throw new Error(`connect option requires a value: ${option}`);
    }

    if (option === "--port") {
      if (remotePort !== undefined) {
        throw new Error("connect accepts --port only once");
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
        throw new Error("connect --port must be an integer between 1 and 65535");
      }
      remotePort = parsed;
      continue;
    }

    if (option === "--host") {
      if (remoteHost !== undefined) {
        throw new Error("connect accepts --host only once");
      }
      if (value.trim().length === 0) {
        throw new Error("connect --host must be non-empty");
      }
      remoteHost = value;
      continue;
    }

    throw new Error(`Unknown connect option: ${option}`);
  }

  if (remotePort === undefined) {
    throw new Error("connect requires --port <remote-port>");
  }

  return remoteHost === undefined
    ? { instanceId, remotePort }
    : { instanceId, remotePort, remoteHost };
}

async function runProvider(args: readonly string[]): Promise<void> {
  const [providerId, featureId, commandName, ...commandArgs] = args;
  const store = new JsonStateStore(stateFilePath());
  const state = await store.read();
  const registry = new ProviderRegistry();
  const featureHost = new ProviderFeatureHost();
  const secretStore = new OsKeyringSecretStore();
  const host = new PluginHost(registry, undefined, featureHost);
  await host.load(configuredPluginLoads(state.plugins), secretStore);

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

    const signal = new AbortController().signal;
    await command.run(commandArgs, {
      signal,
      resolveCredential: (name) => admission.resolveCredential(name, signal),
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
  const secretStore = new OsKeyringSecretStore();
  const host = new PluginHost(registry);
  await host.load(configuredPluginLoads(state.plugins), secretStore);
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

  if (command === "credential") {
    await runPluginCredential(store, args.slice(1));
    return;
  }

  throw new Error(`Unknown plugins command: ${command ?? "(missing)"}`);
}

async function runPluginCredential(
  store: JsonStateStore,
  args: readonly string[],
): Promise<void> {
  const [command, rawSource, name, option, variable] = args;
  if (
    command === "set" &&
    rawSource !== undefined &&
    name !== undefined &&
    option === "--env" &&
    variable !== undefined &&
    args.length === 5
  ) {
    const secret = process.env[variable];
    if (secret === undefined || secret.length === 0) {
      throw new Error(`Environment variable is empty or missing: ${variable}`);
    }
    const result = await setPluginCredential(
      store,
      new OsKeyringSecretStore(),
      persistedPluginSource(rawSource),
      name,
      secret,
    );
    process.stdout.write(`Configured credential ${name} for ${rawSource}\n`);
    if (!result.previousSecretRemoved) {
      process.stderr.write(
        "Warning: previous credential could not be removed from the OS secret store.\n",
      );
    }
    return;
  }

  if (
    command === "remove" &&
    rawSource !== undefined &&
    name !== undefined &&
    args.length === 3
  ) {
    const result = await removePluginCredential(
      store,
      new OsKeyringSecretStore(),
      persistedPluginSource(rawSource),
      name,
    );
    process.stdout.write(`Removed credential ${name} from ${rawSource}\n`);
    if (!result.previousSecretRemoved) {
      process.stderr.write(
        "Warning: credential reference was removed but the OS secret could not be deleted.\n",
      );
    }
    return;
  }

  throw new Error(
    "plugins credential expects set <module> <name> --env <variable> or remove <module> <name>",
  );
}

async function listPlugins(
  store: JsonStateStore,
  explicitSources: readonly string[],
): Promise<void> {
  const canonicalExplicitSources = explicitSources.map(canonicalPluginSource);
  const explicitSourceSet = new Set(canonicalExplicitSources);
  const state = await store.read();
  const configured = configuredPluginLoads(state.plugins);
  const configuredSourceSet = new Set(configured.map((plugin) => plugin.source));
  const registry = new ProviderRegistry();
  const host = new PluginHost(registry);
  await host.load(
    [
      ...configured,
      ...canonicalExplicitSources.filter(
        (source) => !configuredSourceSet.has(source),
      ),
    ],
    new OsKeyringSecretStore(),
  );

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
  let status: PluginStatus | undefined;
  await store.update(async (state) => {
    if (
      state.plugins.some(
        (plugin) => canonicalPluginSource(plugin.source) === source,
      )
    ) {
      throw new Error(`Plugin source is already configured: ${source}`);
    }

    status = await validatePluginActivation(state.plugins, source);
    return {
      ...state,
      plugins: [...state.plugins, { source, enabled: true }],
    };
  });
  process.stdout.write(`Added ${status?.pluginId ?? source}\n`);
}

async function setPluginEnabled(
  store: JsonStateStore,
  source: string,
  enabled: boolean,
): Promise<void> {
  await store.update(async (state) => {
    const index = state.plugins.findIndex(
      (plugin) => canonicalPluginSource(plugin.source) === source,
    );

    if (index < 0) {
      throw new Error(`Plugin source is not configured: ${source}`);
    }
    if (state.plugins[index].enabled === enabled) {
      return state;
    }
    if (enabled) {
      await validatePluginActivation(state.plugins, source);
    }

    const plugins = state.plugins.map<PluginRegistration>(
      (plugin, pluginIndex) =>
        pluginIndex === index ? { ...plugin, source, enabled } : plugin,
    );
    return { ...state, plugins };
  });
  process.stdout.write(`${enabled ? "Enabled" : "Disabled"} ${source}\n`);
}

async function validatePluginActivation(
  plugins: readonly PluginRegistration[],
  source: string,
): Promise<PluginStatus> {
  const configured = configuredPluginLoads(plugins).filter(
    (plugin) => plugin.source !== source,
  );
  const host = new PluginHost(new ProviderRegistry());
  await host.load([...configured, source]);
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
