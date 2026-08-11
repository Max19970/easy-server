#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  isNormalizedError,
  type AvailableAction,
  type HostTrustRequiredError,
} from "@easyai101/easyserver-plugin-sdk";
import { AccessAdapterRegistry } from "./access-adapter-registry.js";
import {
  retryWithHostTrust,
  runForegroundConnect,
} from "./connect-command.js";
import { ConnectionGateway } from "./connection-gateway.js";
import {
  ComputeManager,
  type InventoryInstance,
} from "./compute-manager.js";
import { HostOperationRunner } from "./host-operation.js";
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
import { escapeTerminalText } from "./terminal-text.js";
import { EASYSERVER_VERSION } from "./version.js";
import {
  claimLocalDaemonDescriptor,
  LocalDaemonClient,
  readLocalDaemonDescriptor,
  removeLocalDaemonDescriptor,
  startLocalConnectionDaemon,
  type PersistentConnectionSession,
} from "./local-daemon.js";


class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

const help = `EasyServer

Usage:
  easyserver --help
  easyserver --version
  easyserver plugins list [--plugin <module> ...]
  easyserver plugins add <module>
  easyserver plugins enable <module>
  easyserver plugins disable <module>
  easyserver plugins credential set <module> <name> --env <variable>
  easyserver plugins credential remove <module> <name>
  easyserver instances list
  easyserver instances inspect <instance-id>
  easyserver instances start <instance-id>
  easyserver instances stop <instance-id>
  easyserver instances restart <instance-id>
  easyserver instances destroy <instance-id>
  easyserver connect <instance-id> --port <remote-port> [--host <remote-host>]
  easyserver daemon run
  easyserver sessions create <instance-id> --port <remote-port> [--host <remote-host>]
  easyserver sessions list
  easyserver sessions close <session-id>
  easyserver provider <provider-id> <feature-id> <command> [args...]
`;

await run(process.argv.slice(2));

async function run(args: readonly string[]): Promise<void> {
  const [command] = args;

  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(help);
    return;
  }

  if (command === "--version" || command === "-v" || command === "version") {
    process.stdout.write(`${EASYSERVER_VERSION}\n`);
    return;
  }

  if (command === "daemon") {
    try {
      await runDaemon(args.slice(1));
    } catch (error) {
      reportCliError(error);
    }
    return;
  }

  if (command === "sessions") {
    try {
      await runSessions(args.slice(1));
    } catch (error) {
      reportCliError(error);
    }
    return;
  }

  if (command === "connect") {
    try {
      await runConnect(args.slice(1));
    } catch (error) {
      reportCliError(error);
    }
    return;
  }

  if (command === "provider") {
    try {
      await runProvider(args.slice(1));
    } catch (error) {
      reportCliError(error);
    }
    return;
  }

  if (command === "instances") {
    try {
      await runInstances(args.slice(1));
    } catch (error) {
      reportCliError(error);
    }
    return;
  }

  if (command === "plugins") {
    try {
      await runPlugins(args.slice(1));
    } catch (error) {
      reportCliError(error);
    }
    return;
  }

  process.stderr.write(`Unknown command: ${escapeTerminalText(command)}\n\n${help}`);
  process.exitCode = 1;
}

async function runDaemon(args: readonly string[]): Promise<void> {
  if (args.length !== 1 || args[0] !== "run") {
    throw new CliUsageError("daemon expects run");
  }

  const descriptorPath = daemonFilePath();
  let existing;
  try {
    existing = await readLocalDaemonDescriptor(descriptorPath);
  } catch {
    await removeLocalDaemonDescriptor(descriptorPath);
  }
  if (existing !== undefined) {
    let alive = false;
    try {
      await new LocalDaemonClient(existing.address, existing.authToken).ping();
      alive = true;
    } catch {
      // A stale descriptor is not authoritative; a reachable authenticated daemon is.
    }
    if (alive) {
      throw new Error("EasyServer daemon is already running");
    }
    await removeLocalDaemonDescriptor(descriptorPath);
  }

  const store = new JsonStateStore(stateFilePath());
  const state = await store.read();
  const registry = new ProviderRegistry();
  const secretStore = new OsKeyringSecretStore();
  const host = new PluginHost(registry);
  await host.load(configuredPluginLoads(state.plugins), secretStore);
  const gateway = new ConnectionGateway(
    registry,
    new AccessAdapterRegistry(),
    store,
    secretStore,
  );
  const authToken = randomBytes(32).toString("base64url");
  const daemon = await startLocalConnectionDaemon({ gateway, authToken });
  let releaseDescriptor: (() => Promise<void>) | undefined;
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    releaseDescriptor = await claimLocalDaemonDescriptor(descriptorPath, {
      version: 1,
      address: daemon.address,
      authToken,
    });
    process.stdout.write(
      `EasyServer daemon listening on ${daemon.address.host}:${daemon.address.port}\n`,
    );
    await stopped;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    try {
      await daemon.close();
    } finally {
      await releaseDescriptor?.();
    }
  }
}

async function runSessions(args: readonly string[]): Promise<void> {
  const [command] = args;

  if (command === "list" && args.length === 1) {
    const client = await localDaemonClient();
    process.stdout.write(formatPersistentSessions(await client.listSessions()));
    return;
  }

  if (command === "create") {
    const { instanceId, remotePort, remoteHost } = parseConnectArgs(
      args.slice(1),
      "sessions create",
    );
    const client = await localDaemonClient();
    const request = {
      instanceId,
      remotePort,
      ...(remoteHost === undefined ? {} : { remoteHost }),
    };
    const session = await retryWithHostTrust(
      () => client.createSession(request),
      {
        sshAdapter: new OpenSshAccessAdapter(),
        ...(process.stdin.isTTY && process.stdout.isTTY
          ? { confirmHostTrust: confirmHostTrustInteractively }
          : {}),
      },
    );
    process.stdout.write(
      `${session.id} endpoint=${session.endpoint.host}:${session.endpoint.port}\n`,
    );
    return;
  }

  if (command === "close" && args[1] !== undefined && args.length === 2) {
    const client = await localDaemonClient();
    await client.closeSession(args[1]);
    process.stdout.write(`Closed ${escapeTerminalText(args[1])}\n`);
    return;
  }

  throw new CliUsageError(`Unknown sessions command: ${command ?? "(missing)"}`);
}

async function localDaemonClient(): Promise<LocalDaemonClient> {
  const descriptor = await readLocalDaemonDescriptor(daemonFilePath());
  if (descriptor === undefined) {
    throw new Error("EasyServer daemon is not running");
  }
  return new LocalDaemonClient(descriptor.address, descriptor.authToken);
}

function formatPersistentSessions(
  sessions: readonly PersistentConnectionSession[],
): string {
  if (sessions.length === 0) {
    return "No connection sessions found.\n";
  }

  return `${sessions
    .map((session) => {
      const endpoint =
        "endpoint" in session && session.endpoint !== undefined
          ? ` endpoint=${session.endpoint.host}:${session.endpoint.port}`
          : "";
      const failure =
        session.state === "failed"
          ? ` error=${session.failure.code}:${escapeTerminalText(session.failure.message)}`
          : "";
      return `${session.id} state=${session.state}${endpoint} instance=${session.instanceId} target=${escapeTerminalText(session.remoteHost)}:${session.remotePort}${failure}`;
    })
    .join("\n")}\n`;
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
    `Unknown SSH host ${escapeTerminalText(trust.host)}:${trust.port}\n${escapeTerminalText(trust.keyType)} fingerprint: ${escapeTerminalText(trust.fingerprint)}\n`,
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

function parseConnectArgs(
  args: readonly string[],
  commandName = "connect",
): {
  readonly instanceId: string;
  readonly remotePort: number;
  readonly remoteHost?: string;
} {
  const [instanceId, ...options] = args;
  if (instanceId === undefined || instanceId.trim().length === 0) {
    throw new CliUsageError(`${commandName} requires <instance-id>`);
  }

  let remotePort: number | undefined;
  let remoteHost: string | undefined;

  for (let index = 0; index < options.length; index += 2) {
    const option = options[index];
    const value = options[index + 1];
    if (value === undefined) {
      throw new CliUsageError(`${commandName} option requires a value: ${option}`);
    }

    if (option === "--port") {
      if (remotePort !== undefined) {
        throw new CliUsageError(`${commandName} accepts --port only once`);
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
        throw new CliUsageError(`${commandName} --port must be an integer between 1 and 65535`);
      }
      remotePort = parsed;
      continue;
    }

    if (option === "--host") {
      if (remoteHost !== undefined) {
        throw new CliUsageError(`${commandName} accepts --host only once`);
      }
      if (value.trim().length === 0) {
        throw new CliUsageError(`${commandName} --host must be non-empty`);
      }
      remoteHost = value;
      continue;
    }

    throw new CliUsageError(`Unknown ${commandName} option: ${option}`);
  }

  if (remotePort === undefined) {
    throw new CliUsageError(`${commandName} requires --port <remote-port>`);
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
      throw new CliUsageError(
        `Provider command not found: ${providerId}/${featureId}/${commandName}`,
      );
    }

    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const result = await new HostOperationRunner().run(
        command.operation,
        `Provider Feature ${providerId}/${featureId}/${commandName}`,
        { signal: controller.signal },
        (operationContext) =>
          command.run(commandArgs, {
            signal: operationContext.signal,
            resolveCredential: (name) =>
              admission.resolveCredential(name, operationContext.signal),
            markMutationDispatched: operationContext.markMutationDispatched,
            write(text) {
              process.stdout.write(text);
            },
            writeError(text) {
              process.stderr.write(text);
            },
          }),
      );
      if (result?.refreshProviderInventory) {
        await new ComputeManager(registry, store).refreshProvider(providerId, {
          signal: new AbortController().signal,
        });
      }
    } catch (error) {
      if (
        command.operation === "mutation" &&
        isNormalizedError(error) &&
        error.code === "outcome-unknown"
      ) {
        await new ComputeManager(registry, store)
          .refreshProvider(providerId, {
            signal: new AbortController().signal,
          })
          .catch(() => undefined);
      }
      throw error;
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
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
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);

  try {
    const context = { signal: controller.signal };

    if (command === "list" && args.length === 1) {
      const inventory = await manager.listInventory(context);
      process.stdout.write(formatInventory(inventory.instances));
      for (const provider of inventory.providers) {
        if (provider.status === "failed") {
          process.stderr.write(
            `Provider ${escapeTerminalText(provider.providerId)} inventory failed (${provider.error.code}): ${escapeTerminalText(provider.error.message)}\n`,
          );
        }
      }
      if (!inventory.complete) {
        process.exitCode = inventory.instances.length > 0 ? 2 : 1;
      }
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
      process.stdout.write(`Requested ${action} for ${escapeTerminalText(instanceId)}\n`);
      return;
    }

    throw new CliUsageError(`Unknown instances command: ${command ?? "(missing)"}`);
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
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

  throw new CliUsageError(`Unknown plugins command: ${command ?? "(missing)"}`);
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
    process.stdout.write(
      `Configured credential ${escapeTerminalText(name)} for ${escapeTerminalText(rawSource)}\n`,
    );
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
    process.stdout.write(
      `Removed credential ${escapeTerminalText(name)} from ${escapeTerminalText(rawSource)}\n`,
    );
    if (!result.previousSecretRemoved) {
      process.stderr.write(
        "Warning: credential reference was removed but the OS secret could not be deleted.\n",
      );
    }
    return;
  }

  throw new CliUsageError(
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

  for (;;) {
    const snapshot = await store.read();
    if (
      snapshot.plugins.some(
        (plugin) => canonicalPluginSource(plugin.source) === source,
      )
    ) {
      throw new Error(`Plugin source is already configured: ${source}`);
    }

    status = await validatePluginActivation(snapshot.plugins, source);
    let retry = false;
    await store.update((state) => {
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

  process.stdout.write(`Added ${escapeTerminalText(status?.pluginId ?? source)}\n`);
}

async function setPluginEnabled(
  store: JsonStateStore,
  source: string,
  enabled: boolean,
): Promise<void> {
  if (!enabled) {
    await store.update((state) => {
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
    process.stdout.write(`Disabled ${escapeTerminalText(source)}\n`);
    return;
  }

  for (;;) {
    const snapshot = await store.read();
    const snapshotIndex = findConfiguredPlugin(snapshot.plugins, source);
    if (snapshot.plugins[snapshotIndex].enabled) {
      break;
    }

    await validatePluginActivation(snapshot.plugins, source);
    let retry = false;
    await store.update((state) => {
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

  process.stdout.write(`Enabled ${escapeTerminalText(source)}\n`);
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
        `${escapeTerminalText(feature.providerId)}/${escapeTerminalText(feature.featureId)} ${escapeTerminalText(feature.displayName)}`,
    )
    .join("\n")}\n`;
}

function formatProviderCommands(
  providerId: string,
  featureId: string,
  commands: readonly import("@easyai101/easyserver-plugin-sdk").ProviderCliCommand[],
): string {
  if (commands.length === 0) {
    return `No CLI commands for ${escapeTerminalText(providerId)}/${escapeTerminalText(featureId)}.\n`;
  }

  return `${commands
    .map(
      (command) =>
        `${escapeTerminalText(command.name).padEnd(12)} ${escapeTerminalText(command.description)}`,
    )
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

function formatInventory(instances: readonly InventoryInstance[]): string {
  if (instances.length === 0) {
    return "No compute instances found.\n";
  }

  return `${instances
    .map((instance) => {
      const state = "state" in instance ? instance.state : "unavailable";
      const name = "name" in instance && instance.name !== undefined
        ? ` name=${JSON.stringify(instance.name)}`
        : "";
      const observedAt = "observedAt" in instance
        ? ` observed=${instance.observedAt}`
        : "";
      const actions = instance.availableActions.length === 0
        ? "-"
        : instance.availableActions.join(",");
      return `${instance.id} provider=${escapeTerminalText(instance.providerId)} external=${escapeTerminalText(instance.providerExternalId)} freshness=${instance.freshness} state=${state} actions=${actions}${observedAt}${name}`;
    })
    .join("\n")}\n`;
}

function parsePluginSources(args: readonly string[]): readonly string[] {
  const sources: string[] = [];

  for (let index = 0; index < args.length; index += 2) {
    if (args[index] !== "--plugin" || args[index + 1] === undefined) {
      throw new CliUsageError("plugins list accepts only --plugin <module> pairs");
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
    process.env.EASYSERVER_STATE_FILE ??
    join(homedir(), ".easyserver", "state.json")
  );
}

function daemonFilePath(): string {
  return (
    process.env.EASYSERVER_DAEMON_FILE ??
    join(homedir(), ".easyserver", "daemon.json")
  );
}

function reportCliError(error: unknown): void {
  process.stderr.write(
    error instanceof CliUsageError
      ? `${escapeTerminalText(errorMessage(error))}\n\n${help}`
      : `${escapeTerminalText(errorMessage(error))}\n`,
  );
  process.exitCode = 1;
}

function errorMessage(error: unknown): string {
  if (isNormalizedError(error)) {
    return `${error.code}: ${error.message}`;
  }

  return error instanceof Error ? error.message : String(error);
}
