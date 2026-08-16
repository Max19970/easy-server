#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import {
  hostTrustRequiredError,
  INSTANCE_STATES,
  isHostTrustRequiredError,
  isNormalizedError,
  isProviderCliUsageError,
  normalizedError,
  type AvailableAction,
  type HostTrustRequiredError,
  type InstanceState,
  type OperationContext,
  type ProviderCliCommandMetadata,
  type ProviderCliHelpContribution,
} from "@easyai101/easyserver-plugin-sdk";
import {
  retryWithHostTrust,
  runForegroundConnect,
} from "./connect-command.js";
import { collectDiagnostics } from "./diagnostics.js";
import { acquireFilesystemLock } from "./filesystem-lock.js";
import {
  requireMutationConfirmation,
  type MutationConfirmationPrompt,
} from "./mutation-safety.js";
import type {
  InstanceWaitTarget,
  InventoryInstance,
} from "./compute-manager.js";
import type { BulkInstanceActionResult } from "./instance-operations.js";
import type { ProviderCommandExecutionResult } from "./provider-command-runner.js";
import { formatPluginStatuses } from "./plugin-host.js";
import type { PluginOperations } from "./plugin-operations.js";
import type { ProviderFeatureCommandDescriptor } from "./provider-feature-operations.js";
import {
  findContextualHelpPath,
  formatCoreHelp,
  formatHelpHint,
} from "./cli-help.js";
import { loadProviderCliHelp } from "./provider-cli-help.js";
import {
  createHostRuntime,
  resolveHostRuntimePaths,
} from "./host-runtime.js";
import { sshHostTrustEvidence } from "./host-trust.js";
import { ReloadingEndpointOpener } from "./reloading-endpoint-opener.js";
import { ManagedDaemonOperations } from "./managed-daemon-operations.js";
import { OsKeyringSecretStore } from "./secret-store.js";
import { OpenSshAccessAdapter } from "./ssh-access-adapter.js";
import { escapeTerminalText } from "./terminal-text.js";
import type { EndpointIntentStatus } from "./endpoint-intent-service.js";
import { EASYSERVER_VERSION } from "./version.js";
import {
  claimLocalDaemonDescriptor,
  LocalDaemonClient,
  readLocalDaemonDescriptor,
  removeLocalDaemonDescriptor,
  startLocalConnectionDaemon,
  type LocalDaemonDescriptor,
  type PersistentConnectionSession,
} from "./local-daemon.js";


class CliUsageError extends Error {
  constructor(
    message: string,
    readonly helpCommand?: string,
  ) {
    super(message);
    this.name = "CliUsageError";
  }
}

const CLI_JSON_SCHEMA_VERSION = 1 as const;
type CliOutputMode = "human" | "json";
let cliOutputMode: CliOutputMode = "human";

const invocation = parseCliInvocation(process.argv.slice(2));
cliOutputMode = invocation.outputMode;
await run(invocation.args);

async function run(args: readonly string[]): Promise<void> {
  const [command] = args;

  if (command === undefined && cliOutputMode === "json") {
    reportCliError(
      new CliUsageError("--json requires a command", "easyserver --help"),
      [],
    );
    return;
  }

  if (command === undefined) {
    if (!supportsInteractiveTui()) {
      process.stderr.write(
        "EasyServer TUI requires an interactive terminal. Use easyserver --help for command-mode usage.\n",
      );
      process.exitCode = 1;
      return;
    }

    try {
      const { runTui } = await import("./tui.js");
      await runTui();
    } catch (error) {
      reportCliError(error, []);
    }
    return;
  }

  if (command === "--help" || command === "-h") {
    const help = formatCoreHelp()!;
    writeCliSuccess({ help }, help);
    return;
  }

  const helpFlag = args.at(-1);
  if (helpFlag === "--help" || helpFlag === "-h") {
    const helpPath = args.slice(0, -1);
    const page = formatCoreHelp(helpPath);
    if (page !== undefined) {
      writeCliSuccess({ help: page }, page);
      return;
    }
    if (helpPath[0] === "provider") {
      try {
        await runProviderHelp(helpPath.slice(1));
      } catch (error) {
        reportCliError(error, helpPath);
      }
      return;
    }

    const contextualPath = findContextualHelpPath(helpPath);
    if (cliOutputMode === "json") {
      reportCliError(
        new CliUsageError(
          `Unknown help topic: ${helpPath.join(" ")}`,
          helpCommandForPath(contextualPath),
        ),
        helpPath,
      );
      return;
    }
    process.stderr.write(
      `Unknown help topic: ${escapeTerminalText(helpPath.join(" "))}\n\n${formatHelpHint(contextualPath)}\n`,
    );
    process.stdout.write(formatCoreHelp(contextualPath)!);
    process.exitCode = 1;
    return;
  }

  if (command === "--version" || command === "-v" || command === "version") {
    writeCliSuccess({ version: EASYSERVER_VERSION }, `${EASYSERVER_VERSION}\n`);
    return;
  }

  if (command === "doctor") {
    try {
      await runDoctor(args.slice(1));
    } catch (error) {
      reportCliError(error, args);
    }
    return;
  }

  if (command === "daemon") {
    try {
      await runDaemon(args.slice(1));
    } catch (error) {
      reportCliError(error, args);
    }
    return;
  }

  if (command === "sessions") {
    try {
      await runSessions(args.slice(1));
    } catch (error) {
      reportCliError(error, args);
    }
    return;
  }

  if (command === "connect") {
    try {
      await runConnect(args.slice(1));
    } catch (error) {
      reportCliError(error, args);
    }
    return;
  }

  if (command === "host-trust") {
    try {
      await runHostTrust(args.slice(1));
    } catch (error) {
      reportCliError(error, args);
    }
    return;
  }

  if (command === "provider") {
    try {
      await runProvider(args.slice(1));
    } catch (error) {
      reportCliError(error, args);
    }
    return;
  }

  if (command === "instances") {
    try {
      await runInstances(args.slice(1));
    } catch (error) {
      reportCliError(error, args);
    }
    return;
  }

  if (command === "plugins") {
    try {
      await runPlugins(args.slice(1));
    } catch (error) {
      reportCliError(error, args);
    }
    return;
  }

  if (cliOutputMode === "json") {
    reportCliError(
      new CliUsageError(`Unknown command: ${command}`, "easyserver --help"),
      args,
    );
    return;
  }
  process.stderr.write(
    `Unknown command: ${escapeTerminalText(command)}\n\n${formatHelpHint([])}\n`,
  );
  process.exitCode = 1;
}

async function runDoctor(args: readonly string[]): Promise<void> {
  if (args.length !== 0) {
    throw new CliUsageError("doctor does not accept arguments");
  }

  const report = await collectDiagnostics({
    stateFile: stateFilePath(),
    daemonFile: daemonFilePath(),
  });
  writeCliSuccess(report, `${JSON.stringify(report, null, 2)}\n`);
}

async function runDaemon(args: readonly string[]): Promise<void> {
  if (args.length !== 1) {
    throw new CliUsageError("daemon expects run, start, status, or stop");
  }

  switch (args[0]) {
    case "run":
      await runDaemonForeground();
      return;
    case "start":
      await startManagedDaemon();
      return;
    case "status":
      await reportManagedDaemonStatus();
      return;
    case "stop":
      await stopManagedDaemon();
      return;
    default:
      throw new CliUsageError("daemon expects run, start, status, or stop");
  }
}

async function runDaemonForeground(): Promise<void> {
  const { daemon, releaseDescriptor } = await initializeDaemonForeground();
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    writeCliSuccess(
      { daemon: { status: "running", address: daemon.address } },
      `EasyServer daemon listening on ${daemon.address.host}:${daemon.address.port}\n`,
    );
    await Promise.race([stopped, daemon.shutdownRequested.then(() => undefined)]);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    try {
      await daemon.close();
    } finally {
      await releaseDescriptor();
    }
  }
}

async function initializeDaemonForeground(): Promise<{
  readonly daemon: Awaited<ReturnType<typeof startLocalConnectionDaemon>>;
  readonly releaseDescriptor: () => Promise<void>;
}> {
  const paths = resolveHostRuntimePaths();
  const descriptorPath = paths.daemonFile;
  const lifecycleLock = await acquireFilesystemLock(
    `${descriptorPath}.lifecycle.lock`,
    { timeoutMs: 30_000 },
  );
  let daemon: Awaited<ReturnType<typeof startLocalConnectionDaemon>> | undefined;

  try {
    let existing: LocalDaemonDescriptor | undefined;
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
        // Descriptor inspection and replacement are serialized by the lifecycle lock.
      }
      if (alive) {
        throw new Error("EasyServer daemon is already running");
      }
      await removeLocalDaemonDescriptor(descriptorPath);
    }

    const runtime = await createHostRuntime({
      paths,
      loadConfiguredPlugins: false,
    });
    const gateway = new ReloadingEndpointOpener(
      runtime.stateStore,
      runtime.secretStore,
    );
    const authToken = randomBytes(32).toString("base64url");
    daemon = await startLocalConnectionDaemon({
      gateway,
      authToken,
      stateStore: runtime.stateStore,
    });
    const releaseDescriptor = await claimLocalDaemonDescriptor(descriptorPath, {
      version: 1,
      address: daemon.address,
      authToken,
    });
    return { daemon, releaseDescriptor };
  } catch (error) {
    await daemon?.close().catch(() => undefined);
    throw error;
  } finally {
    await lifecycleLock.release();
  }
}

function managedDaemonOperations(): ManagedDaemonOperations {
  return new ManagedDaemonOperations({
    daemonFile: daemonFilePath(),
    entrypoint: process.argv[1],
    env: process.env,
  });
}

async function reportManagedDaemonStatus(): Promise<void> {
  const state = await managedDaemonOperations().inspect();
  if (state.status === "running") {
    writeCliSuccess(
      { daemon: { status: "running", address: state.descriptor.address } },
      `running endpoint=${state.descriptor.address.host}:${state.descriptor.address.port}\n`,
    );
    return;
  }
  if (state.status === "stopped") {
    writeCliSuccess({ daemon: { status: "stopped" } }, "stopped\n");
    setHumanDegradedExitCode(1);
    return;
  }
  writeCliSuccess(
    { daemon: { status: "stale", reason: state.reason } },
    `stale reason=${escapeTerminalText(state.reason)}\n`,
  );
  setHumanDegradedExitCode(2);
}

async function startManagedDaemon(): Promise<void> {
  const result = await managedDaemonOperations().start();
  writeCliSuccess(
    {
      daemon: {
        status: result.alreadyRunning ? "already-running" : "started",
        address: result.descriptor.address,
      },
    },
    result.alreadyRunning
      ? `EasyServer daemon already running on ${result.descriptor.address.host}:${result.descriptor.address.port}\n`
      : `EasyServer daemon started on ${result.descriptor.address.host}:${result.descriptor.address.port}\n`,
  );
}

async function stopManagedDaemon(): Promise<void> {
  const result = await managedDaemonOperations().stop();
  if (result.status === "already-stopped") {
    writeCliSuccess(
      { daemon: { status: "already-stopped" } },
      "EasyServer daemon already stopped.\n",
    );
    return;
  }
  if (result.status === "stale") {
    writeCliSuccess(
      { daemon: { status: "stale", reason: result.reason } },
      `EasyServer daemon is unreachable; descriptor left intact (${escapeTerminalText(result.reason)}).\n`,
    );
    setHumanDegradedExitCode(2);
    return;
  }
  writeCliSuccess(
    { daemon: { status: "stopped", summary: result.summary } },
    `Stopping EasyServer daemon; closing live-sessions=${result.summary.liveSessions} active-endpoint-intents=${result.summary.activeEndpointIntents}.\nEasyServer daemon stopped.\n`,
  );
}

async function runSessions(args: readonly string[]): Promise<void> {
  const [command] = args;

  if (command === "intents") {
    await runSessionIntents(args.slice(1));
    return;
  }

  if (command === "list" && args.length === 1) {
    const client = await localDaemonClient();
    const sessions = await client.listSessions();
    writeCliSuccess({ sessions }, formatPersistentSessions(sessions));
    return;
  }

  if (command === "create") {
    const {
      instanceId,
      remotePort,
      remoteHost,
      localPort,
      accessMethodId,
      idempotencyKey,
    } = parseConnectArgs(args.slice(1), "sessions create", true);
    const client = await localDaemonClient();
    const request = {
      instanceId,
      remotePort,
      ...(remoteHost === undefined ? {} : { remoteHost }),
      ...(localPort === undefined ? {} : { localPort }),
      ...(accessMethodId === undefined ? {} : { accessMethodId }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    };
    const session = await retryWithHostTrust(
      () => client.createSession(request),
      {
        sshAdapter: new OpenSshAccessAdapter(),
        ...(isInteractiveTerminal()
          ? { confirmHostTrust: confirmHostTrustInteractively }
          : {}),
      },
    );
    writeCliSuccess(
      { session },
      `${session.id}${session.idempotencyKey === undefined ? "" : ` idempotency-key=${escapeTerminalText(session.idempotencyKey)}`} requested-local-port=${session.requestedLocalPort ?? "dynamic"} endpoint=${session.endpoint.host}:${session.endpoint.port} access-method=${escapeTerminalText(session.accessMethod.id)} kind=${escapeTerminalText(session.accessMethod.kind)}\n`,
    );
    return;
  }

  if (command === "close" && args[1] !== undefined && args.length === 2) {
    const client = await localDaemonClient();
    await client.closeSession(args[1]);
    writeCliSuccess(
      { sessionId: args[1], closed: true },
      `Closed ${escapeTerminalText(args[1])}\n`,
    );
    return;
  }

  throw new CliUsageError(`Unknown sessions command: ${command ?? "(missing)"}`);
}

async function runSessionIntents(args: readonly string[]): Promise<void> {
  const [command, name] = args;

  if (command === "list" && args.length === 1) {
    const client = await localDaemonClient();
    const endpointIntents = await client.listEndpointIntents();
    writeCliSuccess({ endpointIntents }, formatEndpointIntents(endpointIntents));
    return;
  }

  if (command === "create" && name !== undefined) {
    const { instanceId, remotePort, remoteHost, localPort, accessMethodId } =
      parseConnectArgs(args.slice(2), "sessions intents create");
    const client = await localDaemonClient();
    const status = await client.createEndpointIntent({
      name,
      instanceId,
      remotePort,
      ...(remoteHost === undefined ? {} : { remoteHost }),
      ...(localPort === undefined ? {} : { localPort }),
      ...(accessMethodId === undefined ? {} : { accessMethodId }),
    });
    writeCliSuccess({ endpointIntent: status }, `${formatEndpointIntent(status)}\n`);
    return;
  }

  if (
    (command === "enable" || command === "disable") &&
    name !== undefined &&
    args.length === 2
  ) {
    const client = await localDaemonClient();
    const status = await client.setEndpointIntentEnabled(name, command === "enable");
    writeCliSuccess({ endpointIntent: status }, `${formatEndpointIntent(status)}\n`);
    return;
  }

  if (command === "retry" && name !== undefined && args.length === 2) {
    const client = await localDaemonClient();
    const status = await client.retryEndpointIntent(name);
    writeCliSuccess({ endpointIntent: status }, `${formatEndpointIntent(status)}\n`);
    return;
  }

  if (command === "remove" && name !== undefined && args.length === 2) {
    const client = await localDaemonClient();
    await client.removeEndpointIntent(name);
    writeCliSuccess(
      { endpointIntent: { name, removed: true } },
      `Removed Endpoint intent ${escapeTerminalText(name)}\n`,
    );
    return;
  }

  throw new CliUsageError(`Unknown sessions intents command: ${command ?? "(missing)"}`);
}

function formatEndpointIntents(intents: readonly EndpointIntentStatus[]): string {
  if (intents.length === 0) {
    return "No Endpoint intents configured.\n";
  }
  return `${intents.map(formatEndpointIntent).join("\n")}\n`;
}

function formatEndpointIntent(intent: EndpointIntentStatus): string {
  const endpoint =
    intent.state === "live"
      ? ` endpoint=${intent.endpoint.host}:${intent.endpoint.port} access-method=${escapeTerminalText(intent.accessMethod.id)} kind=${escapeTerminalText(intent.accessMethod.kind)}`
      : "";
  const failure =
    intent.state === "error"
      ? ` error=${intent.failure.code}:${escapeTerminalText(intent.failure.message)}`
      : "";
  return `${escapeTerminalText(intent.name)} state=${intent.state} enabled=${intent.enabled} instance=${escapeTerminalText(intent.instanceId)} target=${escapeTerminalText(intent.remoteHost)}:${intent.remotePort} requested-local-port=${intent.localPort ?? "dynamic"} requested-access-method=${intent.accessMethodId === undefined ? "default" : escapeTerminalText(intent.accessMethodId)}${endpoint}${failure}`;
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
      return `${session.id} state=${session.state}${endpoint}${session.idempotencyKey === undefined ? "" : ` idempotency-key=${escapeTerminalText(session.idempotencyKey)}`} requested-local-port=${session.requestedLocalPort ?? "dynamic"} access-method=${escapeTerminalText(session.accessMethod.id)} kind=${escapeTerminalText(session.accessMethod.kind)} instance=${session.instanceId} target=${escapeTerminalText(session.remoteHost)}:${session.remotePort}${failure}`;
    })
    .join("\n")}\n`;
}

async function runConnect(args: readonly string[]): Promise<void> {
  const {
    instanceId,
    remotePort,
    remoteHost,
    localPort,
    accessMethodId,
  } = parseConnectArgs(args);
  const runtime = await createHostRuntime({ paths: resolveHostRuntimePaths() });
  const { connectionGateway: gateway, sshAdapter } = runtime;
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
      localPort,
      accessMethodId,
      context: { signal: controller.signal },
      ...(isInteractiveTerminal()
        ? { confirmHostTrust: confirmHostTrustInteractively }
        : {}),
      onEndpoint(endpoint, accessMethod) {
        writeCliSuccess(
          { endpoint, accessMethod },
          `${endpoint.host}:${endpoint.port} access-method=${escapeTerminalText(accessMethod.id)} kind=${escapeTerminalText(accessMethod.kind)}\n`,
        );
      },
    });
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

async function runHostTrust(args: readonly string[]): Promise<void> {
  const [command, ...options] = args;
  if (command !== "approve") {
    throw new CliUsageError("host-trust expects approve");
  }

  const trust = parseHostTrustApprovalArgs(options);
  await new OpenSshAccessAdapter().enrollHostKey(trust);
  const evidence = sshHostTrustEvidence(trust);
  writeCliSuccess(
    { hostTrust: evidence, approved: true },
    `Approved SSH host trust for ${escapeTerminalText(trust.host)}:${trust.port} ${escapeTerminalText(trust.keyType)} ${escapeTerminalText(trust.fingerprint)}\n`,
  );
}

function isInteractiveTerminal(): boolean {
  return Boolean(
    cliOutputMode === "human" && process.stdin.isTTY && process.stdout.isTTY,
  );
}

function supportsInteractiveTui(): boolean {
  return Boolean(
    process.stdin.isTTY &&
      process.stdout.isTTY &&
      typeof process.stdin.setRawMode === "function",
  );
}

async function confirmRiskyMutationInteractively(
  prompt: MutationConfirmationPrompt,
  context: { readonly signal: AbortSignal },
): Promise<boolean> {
  process.stdout.write(
    `${escapeTerminalText(prompt.summary)}\nRisk: ${prompt.risks.join(", ")}\nConsequence: ${escapeTerminalText(prompt.consequence)}\n`,
  );
  const readline = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const answer = await readline.question(
      'Continue? Type "yes" to confirm: ',
      { signal: context.signal },
    );
    return answer.trim().toLowerCase() === "yes";
  } catch (error) {
    if (context.signal.aborted) {
      return false;
    }
    throw error;
  } finally {
    readline.close();
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

function parseHostTrustApprovalArgs(
  args: readonly string[],
): HostTrustRequiredError {
  let host: string | undefined;
  let port: number | undefined;
  let keyType: string | undefined;
  let fingerprint: string | undefined;

  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (value === undefined) {
      throw new CliUsageError(`host-trust approve option requires a value: ${option}`);
    }

    if (option === "--host") {
      if (host !== undefined) {
        throw new CliUsageError("host-trust approve accepts --host only once");
      }
      if (value.trim().length === 0) {
        throw new CliUsageError("host-trust approve --host must be non-empty");
      }
      host = value;
      continue;
    }

    if (option === "--port") {
      if (port !== undefined) {
        throw new CliUsageError("host-trust approve accepts --port only once");
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
        throw new CliUsageError(
          "host-trust approve --port must be an integer between 1 and 65535",
        );
      }
      port = parsed;
      continue;
    }

    if (option === "--key-type") {
      if (keyType !== undefined) {
        throw new CliUsageError("host-trust approve accepts --key-type only once");
      }
      if (value.trim().length === 0) {
        throw new CliUsageError("host-trust approve --key-type must be non-empty");
      }
      keyType = value;
      continue;
    }

    if (option === "--fingerprint") {
      if (fingerprint !== undefined) {
        throw new CliUsageError("host-trust approve accepts --fingerprint only once");
      }
      if (value.trim().length === 0) {
        throw new CliUsageError("host-trust approve --fingerprint must be non-empty");
      }
      fingerprint = value;
      continue;
    }

    throw new CliUsageError(`Unknown host-trust approve option: ${option}`);
  }

  if (
    host === undefined ||
    port === undefined ||
    keyType === undefined ||
    fingerprint === undefined
  ) {
    throw new CliUsageError(
      "host-trust approve requires --host, --port, --key-type and --fingerprint",
    );
  }

  return hostTrustRequiredError(host, port, keyType, fingerprint);
}

function parseConnectArgs(
  args: readonly string[],
  commandName = "connect",
  allowIdempotencyKey = false,
): {
  readonly instanceId: string;
  readonly remotePort: number;
  readonly remoteHost?: string;
  readonly localPort?: number;
  readonly accessMethodId?: string;
  readonly idempotencyKey?: string;
} {
  const [instanceId, ...options] = args;
  if (instanceId === undefined || instanceId.trim().length === 0) {
    throw new CliUsageError(`${commandName} requires <instance-id>`);
  }

  let remotePort: number | undefined;
  let remoteHost: string | undefined;
  let localPort: number | undefined;
  let accessMethodId: string | undefined;
  let idempotencyKey: string | undefined;

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

    if (option === "--local-port") {
      if (localPort !== undefined) {
        throw new CliUsageError(`${commandName} accepts --local-port only once`);
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
        throw new CliUsageError(
          `${commandName} --local-port must be an integer between 1 and 65535`,
        );
      }
      localPort = parsed;
      continue;
    }

    if (option === "--access-method") {
      if (accessMethodId !== undefined) {
        throw new CliUsageError(`${commandName} accepts --access-method only once`);
      }
      if (value.trim().length === 0) {
        throw new CliUsageError(`${commandName} --access-method must be non-empty`);
      }
      accessMethodId = value;
      continue;
    }

    if (option === "--idempotency-key" && allowIdempotencyKey) {
      if (idempotencyKey !== undefined) {
        throw new CliUsageError(`${commandName} accepts --idempotency-key only once`);
      }
      if (value.trim().length === 0 || value.length > 128) {
        throw new CliUsageError(
          `${commandName} --idempotency-key must be a non-empty string up to 128 characters`,
        );
      }
      idempotencyKey = value;
      continue;
    }

    throw new CliUsageError(`Unknown ${commandName} option: ${option}`);
  }

  if (remotePort === undefined) {
    throw new CliUsageError(`${commandName} requires --port <remote-port>`);
  }

  return {
    instanceId,
    remotePort,
    ...(remoteHost === undefined ? {} : { remoteHost }),
    ...(localPort === undefined ? {} : { localPort }),
    ...(accessMethodId === undefined ? {} : { accessMethodId }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

async function runProviderHelp(args: readonly string[]): Promise<void> {
  const [providerId, featureId, commandName, ...extra] = args;
  if (providerId === undefined || extra.length > 0) {
    throw new CliUsageError(
      "provider help expects <provider-id>, optionally followed by <feature-id> and <command>",
    );
  }

  const contribution = await loadProviderCliHelp(providerId, {
    stateFile: stateFilePath(),
  });
  if (contribution === undefined) {
    const help = formatProviderHelpUnavailable(providerId);
    writeCliSuccess({ help }, help);
    return;
  }

  if (featureId === undefined) {
    const help = formatProviderHelpContribution(contribution);
    writeCliSuccess({ help }, help);
    return;
  }

  const feature = contribution.features.find((candidate) => candidate.id === featureId);
  if (feature === undefined) {
    throw new CliUsageError(
      `Provider help feature not found: ${providerId}/${featureId}`,
      `easyserver provider ${providerId} --help`,
    );
  }
  if (commandName === undefined) {
    const help = formatProviderHelpFeature(
      providerId,
      feature.id,
      feature.displayName,
      feature.commands,
    );
    writeCliSuccess({ help }, help);
    return;
  }

  const command = feature.commands.find((candidate) => candidate.name === commandName);
  if (command === undefined) {
    throw new CliUsageError(
      `Provider help command not found: ${providerId}/${featureId}/${commandName}`,
      `easyserver provider ${providerId} ${featureId} --help`,
    );
  }
  const help = formatProviderCommandHelp(providerId, featureId, command);
  writeCliSuccess({ help }, help);
}

async function runProvider(args: readonly string[]): Promise<void> {
  const [providerId, featureId, commandName, ...commandArgs] = args;
  const runtime = await createHostRuntime({ paths: resolveHostRuntimePaths() });
  const operations = runtime.providerFeatureOperations;

  if (providerId === undefined) {
    const features = operations.listFeatures();
    writeCliSuccess({ features }, formatProviderFeatures(features));
    return;
  }

  if (featureId === undefined) {
    const features = operations.listFeatures(providerId);
    writeCliSuccess({ features }, formatProviderFeatures(features));
    return;
  }

  const commands = operations.listCommands(providerId, featureId);
  if (commandName === undefined) {
    writeCliSuccess(
      { providerId, featureId, commands },
      formatProviderCommands(providerId, featureId, commands),
    );
    return;
  }

  const command = commands.find((candidate) => candidate.name === commandName);
  if (command === undefined) {
    throw new CliUsageError(
      `Provider command not found: ${providerId}/${featureId}/${commandName}`,
      `easyserver provider ${providerId} ${featureId} --help`,
    );
  }

  const assumeYes = command.risks.length > 0 && commandArgs[0] === "--yes";
  const providerCommandArgs = assumeYes ? commandArgs.slice(1) : commandArgs;

  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const interactive = isInteractiveTerminal();
    const providerTranscript = { stdout: "", stderr: "" };
    try {
      const execution = await operations.execute({
        providerId,
        featureId,
        commandName,
        args: providerCommandArgs,
        context: { signal: controller.signal },
        assumeYes,
        interaction: {
          ...(interactive ? { confirm: confirmRiskyMutationInteractively } : {}),
          transcript(event) {
            if (cliOutputMode === "json") {
              if (event.stream === "output") {
                providerTranscript.stdout += event.text;
              } else {
                providerTranscript.stderr += event.text;
              }
              return;
            }
            if (event.stream === "output") {
              process.stdout.write(event.text);
            } else {
              process.stderr.write(event.text);
            }
          },
        },
      });
      if (cliOutputMode === "json") {
        writeCliSuccess(
          {
            provider: {
              providerId,
              featureId,
              commandName,
              stdout: providerTranscript.stdout,
              stderr: providerTranscript.stderr,
            },
            execution,
          },
          "",
        );
      } else {
        reportProviderCommandHandoff(
          providerId,
          featureId,
          commandName,
          execution,
        );
      }
    } catch (error) {
      if (isProviderCliUsageError(error)) {
        throw new CliUsageError(
          error.message,
          `easyserver provider ${providerId} ${featureId} ${commandName} --help`,
        );
      }
      throw error;
    }
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

async function runInstances(args: readonly string[]): Promise<void> {
  const [command, instanceId, ...commandOptions] = args;
  const runtime = await createHostRuntime({ paths: resolveHostRuntimePaths() });
  const { computeManager: manager, instanceOperations } = runtime;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);

  try {
    const context = { signal: controller.signal };

    if (command === "list" && args.length === 1) {
      const inventory = await manager.listInventory(context);
      writeCliSuccess({ inventory }, formatInventory(inventory.instances));
      if (cliOutputMode === "human") {
        for (const provider of inventory.providers) {
          if (provider.status === "failed") {
            process.stderr.write(
              `Provider ${escapeTerminalText(provider.providerId)} inventory failed (${provider.error.code}): ${escapeTerminalText(provider.error.message)}\n`,
            );
          }
        }
      }
      if (!inventory.complete) {
        setHumanDegradedExitCode(inventory.instances.length > 0 ? 2 : 1);
      }
      return;
    }

    if (command === "inspect" && instanceId !== undefined && args.length === 2) {
      const instance = await manager.inspectInstance(instanceId, context);
      if (instance === undefined) {
        throw normalizedError("not-found", `Compute Instance not found: ${instanceId}`);
      }

      writeCliSuccess({ instance }, `${JSON.stringify(instance, null, 2)}\n`);
      return;
    }

    if (
      command === "access-methods" &&
      instanceId !== undefined &&
      args.length === 2
    ) {
      const accessMethods = await runtime.connectionGateway.listAccessMethods(
        instanceId,
        context,
      );
      writeCliSuccess(
        { instanceId, accessMethods },
        formatAccessMethods(accessMethods),
      );
      return;
    }

    if (command === "adopt" && instanceId !== undefined && args.length === 2) {
      await instanceOperations.adopt(instanceId);
      writeCliSuccess(
        { instanceId, management: "managed" },
        `Adopted ${escapeTerminalText(instanceId)} for EasyServer management\n`,
      );
      return;
    }

    if (command === "wait" && instanceId !== undefined) {
      const wait = parseInstanceWaitArgs(commandOptions);
      const result = await manager.waitForInstance(
        instanceId,
        wait.target,
        { timeoutMs: wait.timeoutMs },
        context,
      );
      writeCliSuccess(
        { instanceId, result },
        `Reached state=${result.observedState} for ${escapeTerminalText(instanceId)}\n`,
      );
      return;
    }

    const action = instanceAction(command);
    if (action !== undefined) {
      const { instanceIds, actionOptions } = parseInstanceActionRequest(
        action,
        args.slice(1),
      );
      const interactive = isInteractiveTerminal();
      const warnings: string[] = [];
      const interaction = {
        assumeYes: actionOptions.assumeYes,
        warning(message: string) {
          if (cliOutputMode === "json") {
            warnings.push(message);
          } else {
            process.stderr.write(`Warning: ${escapeTerminalText(message)}\n`);
          }
        },
        ...(interactive
          ? {
              confirm: (
                prompt: MutationConfirmationPrompt,
                _details: unknown,
                confirmContext: OperationContext,
              ) => confirmRiskyMutationInteractively(prompt, confirmContext),
            }
          : {}),
      };

      if (instanceIds.length === 1) {
        const target = instanceIds[0]!;
        if (action === "instance.destroy") {
          await instanceOperations.perform({
            instanceId: target,
            action,
            closeConnections: actionOptions.closeSessions,
            context,
            interaction,
          });
        } else {
          await instanceOperations.perform({ instanceId: target, action, context });
        }
        writeCliSuccess(
          { action, instanceId: target, status: "requested", warnings },
          `Requested ${action} for ${escapeTerminalText(target)}\n`,
        );
        return;
      }

      const result = await instanceOperations.performBulk({
        instanceIds,
        action,
        context,
        ...(action !== "instance.destroy"
          ? {}
          : {
              closeConnections: actionOptions.closeSessions,
              interaction,
            }),
      });
      writeCliSuccess(
        { result, warnings },
        formatBulkInstanceActionResult(result),
      );
      if (result.summary.failed + result.summary.outcomeUnknown > 0) {
        setHumanDegradedExitCode(result.summary.completed > 0 ? 2 : 1);
      }
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
  const runtime = await createHostRuntime({
    paths: resolveHostRuntimePaths(),
    loadConfiguredPlugins: false,
  });
  const operations = runtime.pluginOperations;

  if (command === "list") {
    const plugins = await operations.list(parsePluginSources(args.slice(1)));
    writeCliSuccess({ plugins }, formatPluginStatuses(plugins));
    return;
  }

  if (command === "add" && args.length === 2) {
    const result = await operations.add(args[1]);
    writeCliSuccess(
      { plugin: result },
      `Added ${escapeTerminalText(result.pluginId)}\n`,
    );
    return;
  }

  if ((command === "enable" || command === "disable") && args.length === 2) {
    const enabled = command === "enable";
    const result = await operations.setEnabled(args[1], enabled);
    writeCliSuccess(
      { plugin: { ...result, enabled } },
      `${enabled ? "Enabled" : "Disabled"} ${escapeTerminalText(result.source)}\n`,
    );
    return;
  }

  if (command === "credential") {
    await runPluginCredential(operations, args.slice(1));
    return;
  }

  throw new CliUsageError(`Unknown plugins command: ${command ?? "(missing)"}`);
}

async function runPluginCredential(
  operations: PluginOperations,
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
    const result = await operations.setCredential(rawSource, name, secret);
    writeCliSuccess(
      {
        credential: {
          source: rawSource,
          name,
          configured: true,
          previousSecretRemoved: result.previousSecretRemoved,
        },
      },
      `Configured credential ${escapeTerminalText(name)} for ${escapeTerminalText(rawSource)}\n`,
    );
    if (!result.previousSecretRemoved && cliOutputMode === "human") {
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
    const result = await operations.removeCredential(rawSource, name);
    writeCliSuccess(
      {
        credential: {
          source: rawSource,
          name,
          configured: false,
          previousSecretRemoved: result.previousSecretRemoved,
        },
      },
      `Removed credential ${escapeTerminalText(name)} from ${escapeTerminalText(rawSource)}\n`,
    );
    if (!result.previousSecretRemoved && cliOutputMode === "human") {
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

function formatProviderHelpUnavailable(providerId: string): string {
  const safeProviderId = escapeTerminalText(providerId);
  return `Provider-specific help is unavailable for ${safeProviderId}.\n\nEasyServer intentionally did not import the normal Provider Plugin entrypoint for --help. The configured plugin must publish a dedicated side-effect-free ./easyserver-help contribution to expose provider-specific help without credentials or provider work.\n\nYou can still use \`easyserver provider\` to inspect features through the normal runtime path.\n`;
}

function formatProviderHelpContribution(
  contribution: ProviderCliHelpContribution,
): string {
  const providerId = escapeTerminalText(contribution.providerId);
  const lines = [
    contribution.displayName === undefined
      ? `Provider ${providerId}`
      : `${escapeTerminalText(contribution.displayName)} (${providerId})`,
    "",
    "Side-effect-free Provider Plugin help metadata.",
    "",
    "Features:",
  ];
  if (contribution.features.length === 0) {
    lines.push("  No provider features declare CLI help.");
  } else {
    for (const feature of contribution.features) {
      lines.push(
        `  ${escapeTerminalText(feature.id).padEnd(20)} ${escapeTerminalText(feature.displayName)}`,
      );
    }
    lines.push(
      "",
      `Run \`easyserver provider ${providerId} <feature-id> --help\` to list provider-owned commands.`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function formatProviderHelpFeature(
  providerId: string,
  featureId: string,
  displayName: string,
  commands: readonly ProviderCliCommandMetadata[],
): string {
  const safeProviderId = escapeTerminalText(providerId);
  const safeFeatureId = escapeTerminalText(featureId);
  const lines = [
    `${escapeTerminalText(displayName)} (${safeProviderId}/${safeFeatureId})`,
    "",
    "Provider-owned CLI commands:",
  ];
  if (commands.length === 0) {
    lines.push("  No CLI commands declared.");
  } else {
    for (const command of commands) {
      lines.push(
        `  ${escapeTerminalText(command.name).padEnd(16)} ${escapeTerminalText(command.description)}`,
      );
    }
    lines.push(
      "",
      `Run \`easyserver provider ${safeProviderId} ${safeFeatureId} <command> --help\` for arguments and safety semantics.`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function formatProviderCommands(
  providerId: string,
  featureId: string,
  commands: readonly ProviderFeatureCommandDescriptor[],
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

function formatProviderCommandHelp(
  providerId: string,
  featureId: string,
  command: ProviderCliCommandMetadata,
): string {
  const commandPath = `easyserver provider ${escapeTerminalText(providerId)} ${escapeTerminalText(featureId)} ${escapeTerminalText(command.name)}`;
  const risks = command.risks ?? [];
  const safetyUsage = risks.length > 0 ? " [--yes]" : "";
  const help = command.help;
  if (help === undefined) {
    const safetyNote = risks.length === 0
      ? ""
      : `\n\nSafety:\n  Risks: ${risks.join(", ")}\n  Interactive terminals require confirmation; non-interactive calls require --yes.`;
    return `${escapeTerminalText(command.description)}\n\nUsage:\n  ${commandPath}${safetyUsage} [provider-args...]\n\nThis Provider Plugin does not declare structured argument help for this command.${safetyNote}\n`;
  }

  const argumentsHelp = help.arguments ?? [];
  const optionsHelp = help.options ?? [];
  const usageParts = [
    ...(risks.length > 0 ? ["[--yes]"] : []),
    ...argumentsHelp.map((argument) => {
      const token = `<${escapeTerminalText(argument.name)}>${argument.repeatable ? "..." : ""}`;
      return argument.required ? token : `[${token}]`;
    }),
    ...optionsHelp.map((option) => {
      const value =
        option.valueName === undefined
          ? ""
          : ` <${escapeTerminalText(option.valueName)}>`;
      const token = `${escapeTerminalText(option.name)}${value}${option.repeatable ? "..." : ""}`;
      return option.required ? token : `[${token}]`;
    }),
  ];

  const lines = [
    escapeTerminalText(command.description),
    `Operation: ${command.operation}`,
    "",
    "Usage:",
    `  ${commandPath}${usageParts.length === 0 ? "" : ` ${usageParts.join(" ")}`}`,
  ];

  if (argumentsHelp.length > 0) {
    lines.push("", "Arguments:");
    for (const argument of argumentsHelp) {
      lines.push(
        `  <${escapeTerminalText(argument.name)}> ${formatProviderHelpMarkers(argument.required, argument.repeatable)} ${escapeTerminalText(argument.description)}`,
      );
    }
  }

  if (optionsHelp.length > 0) {
    lines.push("", "Options:");
    for (const option of optionsHelp) {
      const value =
        option.valueName === undefined
          ? ""
          : ` <${escapeTerminalText(option.valueName)}>`;
      lines.push(
        `  ${escapeTerminalText(option.name)}${value} ${formatProviderHelpMarkers(option.required, option.repeatable)} ${escapeTerminalText(option.description)}`,
      );
    }
  }

  if ((help.examples?.length ?? 0) > 0) {
    lines.push("", "Examples:");
    for (const example of help.examples ?? []) {
      lines.push(`  ${commandPath} ${escapeTerminalText(example)}`);
    }
  }

  if (risks.length > 0) {
    lines.push(
      "",
      "Safety:",
      `  Risks: ${risks.join(", ")}`,
      "  Interactive terminals require confirmation; non-interactive calls require --yes.",
    );
  }

  return `${lines.join("\n")}\n`;
}

function formatProviderHelpMarkers(
  required: boolean,
  repeatable: boolean | undefined,
): string {
  return `(${required ? "required" : "optional"}${repeatable ? ", repeatable" : ""})`;
}

function reportProviderCommandHandoff(
  providerId: string,
  featureId: string,
  commandName: string,
  execution: ProviderCommandExecutionResult,
): void {
  if (execution.operation !== "mutation") {
    return;
  }

  for (const handoff of execution.handoff.canonicalInstances) {
    process.stdout.write(
      `EasyServer instance ${escapeTerminalText(handoff.instanceId)} provider=${escapeTerminalText(providerId)} external=${escapeTerminalText(handoff.providerExternalId)}\n`,
    );
  }

  if (execution.handoff.status === "partial") {
    process.stderr.write(
      `Mutation succeeded, but canonical EasyServer identity is still unavailable for provider resource(s): ${formatProviderExternalIds(execution.handoff.unresolvedProviderExternalIds)}.\n${providerMutationRecoveryGuidance(providerId, featureId, commandName)}\n`,
    );
    return;
  }

  if (execution.handoff.status === "failed") {
    const detail =
      execution.handoff.failure === "invalid-provider-result"
        ? "the Provider Plugin returned an invalid handoff result"
        : execution.handoff.failure === "management-intent-persist-failed"
          ? "EasyServer could not persist the acquired-resource management intent"
          : "the follow-up provider inventory refresh failed";
    const affected =
      execution.handoff.affectedProviderExternalIds.length === 0
        ? ""
        : ` Affected provider resource(s): ${formatProviderExternalIds(execution.handoff.affectedProviderExternalIds)}.`;
    process.stderr.write(
      `Mutation succeeded, but EasyServer could not complete canonical instance handoff because ${detail}.${affected}\n${providerMutationRecoveryGuidance(providerId, featureId, commandName)}\n`,
    );
  }
}

function providerMutationRecoveryGuidance(
  providerId: string,
  featureId: string,
  commandName: string,
): string {
  return `Do not repeat ${escapeTerminalText(providerId)}/${escapeTerminalText(featureId)}/${escapeTerminalText(commandName)} just to obtain an instance ID. Run easyserver instances list to observe/refresh inventory, or wait and retry observation.`;
}

function formatProviderExternalIds(ids: readonly string[]): string {
  return ids.map((id) => escapeTerminalText(id)).join(", ");
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

function parseInstanceWaitArgs(options: readonly string[]): {
  readonly target: InstanceWaitTarget;
  readonly timeoutMs: number;
} {
  let target: InstanceWaitTarget | undefined;
  let timeoutMs = 120_000;

  for (let index = 0; index < options.length; index += 2) {
    const option = options[index];
    const value = options[index + 1];
    if (value === undefined) {
      throw new CliUsageError(`instances wait option requires a value: ${option}`);
    }

    if (option === "--state") {
      if (target !== undefined) {
        throw new CliUsageError("instances wait accepts --state only once");
      }
      if (
        value !== "absent" &&
        !INSTANCE_STATES.includes(value as InstanceState)
      ) {
        throw new CliUsageError(
          `instances wait --state must be absent or a normalized state: ${INSTANCE_STATES.join(", ")}`,
        );
      }
      target = value as InstanceWaitTarget;
      continue;
    }

    if (option === "--timeout") {
      if (timeoutMs !== 120_000) {
        throw new CliUsageError("instances wait accepts --timeout only once");
      }
      const seconds = Number(value);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86_400) {
        throw new CliUsageError(
          "instances wait --timeout must be an integer between 1 and 86400 seconds",
        );
      }
      timeoutMs = seconds * 1_000;
      continue;
    }

    throw new CliUsageError(`Unknown instances wait option: ${option}`);
  }

  if (target === undefined) {
    throw new CliUsageError("instances wait requires --state <state|absent>");
  }
  return { target, timeoutMs };
}

interface InstanceActionOptions {
  readonly assumeYes: boolean;
  readonly closeSessions: boolean;
}

function parseInstanceActionRequest(
  action: AvailableAction,
  args: readonly string[],
): {
  readonly instanceIds: readonly string[];
  readonly actionOptions: InstanceActionOptions;
} {
  const instanceIds: string[] = [];
  const options: string[] = [];
  for (const value of args) {
    if (value.startsWith("--")) {
      options.push(value);
    } else {
      instanceIds.push(value);
    }
  }
  if (instanceIds.length === 0) {
    throw new CliUsageError(`${action} requires at least one instance ID`);
  }
  if (new Set(instanceIds).size !== instanceIds.length) {
    throw new CliUsageError(`${action} accepts each instance ID only once`);
  }
  return {
    instanceIds,
    actionOptions: parseInstanceActionOptions(action, options),
  };
}

function parseInstanceActionOptions(
  action: AvailableAction,
  options: readonly string[],
): InstanceActionOptions {
  if (action !== "instance.destroy") {
    if (options.length > 0) {
      throw new CliUsageError(`${action} does not accept options`);
    }
    return { assumeYes: false, closeSessions: false };
  }

  let assumeYes = false;
  let closeSessions = false;
  for (const option of options) {
    if (option === "--yes") {
      if (assumeYes) {
        throw new CliUsageError("instances destroy accepts --yes only once");
      }
      assumeYes = true;
      continue;
    }
    if (option === "--close-sessions") {
      if (closeSessions) {
        throw new CliUsageError(
          "instances destroy accepts --close-sessions only once",
        );
      }
      closeSessions = true;
      continue;
    }
    throw new CliUsageError(
      "instances destroy accepts only --yes and --close-sessions",
    );
  }
  return { assumeYes, closeSessions };
}

function formatBulkInstanceActionResult(
  result: BulkInstanceActionResult,
): string {
  const lines = result.results.map((item) =>
    item.status === "completed"
      ? `${escapeTerminalText(item.instanceId)} status=completed`
      : `${escapeTerminalText(item.instanceId)} status=${item.status} code=${item.error.code} message=${JSON.stringify(escapeTerminalText(item.error.message))}`,
  );
  lines.push(
    `Summary action=${result.action} requested=${result.summary.requested} completed=${result.summary.completed} failed=${result.summary.failed} outcome-unknown=${result.summary.outcomeUnknown}`,
  );
  return `${lines.join("\n")}\n`;
}

function formatAccessMethods(
  methods: readonly import("./connection-gateway.js").AccessMethodDescriptor[],
): string {
  if (methods.length === 0) {
    return "No TCP-forward Access Methods available.\n";
  }
  return `${methods
    .map(
      (method) =>
        `${escapeTerminalText(method.id)} kind=${escapeTerminalText(method.kind)} mode=${method.mode}`,
    )
    .join("\n")}\n`;
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
      return `${instance.id} provider=${escapeTerminalText(instance.providerId)} external=${escapeTerminalText(instance.providerExternalId)} management=${instance.management} freshness=${instance.freshness} state=${state} actions=${actions}${observedAt}${name}`;
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

function parseCliInvocation(args: readonly string[]): {
  readonly outputMode: CliOutputMode;
  readonly args: readonly string[];
} {
  return args[0] === "--json"
    ? { outputMode: "json", args: args.slice(1) }
    : { outputMode: "human", args };
}

function setHumanDegradedExitCode(code: 1 | 2): void {
  if (cliOutputMode === "human") {
    process.exitCode = code;
  }
}

function writeCliSuccess<T>(data: T, humanText: string): void {
  process.stdout.write(
    cliOutputMode === "json"
      ? `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, ok: true, data })}\n`
      : humanText,
  );
}

function helpCommandForPath(path: readonly string[]): string {
  return path.length === 0
    ? "easyserver --help"
    : `easyserver ${path.join(" ")} --help`;
}

function stateFilePath(): string {
  return resolveHostRuntimePaths().stateFile;
}

function daemonFilePath(): string {
  return resolveHostRuntimePaths().daemonFile;
}

function reportCliError(error: unknown, args: readonly string[]): void {
  if (cliOutputMode === "json") {
    const helpCommand =
      error instanceof CliUsageError
        ? error.helpCommand ?? helpCommandForPath(findContextualHelpPath(args))
        : undefined;
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: CLI_JSON_SCHEMA_VERSION,
        ok: false,
        error: {
          code: isNormalizedError(error)
            ? error.code
            : error instanceof CliUsageError
              ? "usage-error"
              : "command-failed",
          message: isNormalizedError(error) ? error.message : errorMessage(error),
          ...(isHostTrustRequiredError(error)
            ? { hostTrust: sshHostTrustEvidence(error) }
            : {}),
          ...(helpCommand === undefined ? {} : { helpCommand }),
        },
      })}\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stderr.write(
    error instanceof CliUsageError
      ? `${escapeTerminalText(errorMessage(error))}\n\n${error.helpCommand === undefined ? formatHelpHint(findContextualHelpPath(args)) : `See: ${escapeTerminalText(error.helpCommand)}`}\n`
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
