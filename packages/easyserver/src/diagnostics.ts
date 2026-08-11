import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
import {
  LocalDaemonClient,
  readLocalDaemonDescriptor,
} from "./local-daemon.js";
import {
  PluginHost,
  type PluginImporter,
  type PluginStatus,
} from "./plugin-host.js";
import { ProviderRegistry } from "./provider-registry.js";
import { JsonStateStore, type EasyServerState } from "./state-store.js";
import { EASYSERVER_VERSION } from "./version.js";

export interface DiagnosticsReport {
  readonly schemaVersion: 1;
  readonly easyserver: {
    readonly version: string;
  };
  readonly runtime: {
    readonly node: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
  };
  readonly state: {
    readonly status: "ok" | "empty" | "error";
    readonly configuredPlugins: number;
    readonly credentialBindings: number;
    readonly instanceBindings: number;
  };
  readonly plugins: readonly DiagnosticsPluginStatus[];
  readonly daemon: {
    readonly status: "running" | "stopped" | "unreachable" | "invalid";
    readonly sessionCount?: number;
  };
  readonly access: {
    readonly ssh: "available" | "unavailable";
    readonly sshKeyscan: "available" | "unavailable";
  };
}

export interface DiagnosticsPluginStatus {
  readonly identity: string;
  readonly state: "loaded" | "disabled" | "failed";
  readonly version?: string;
  readonly providerId?: string;
  readonly failure?: "incompatible" | "timeout" | "load-failed";
}

export interface DiagnosticsBuildInput {
  readonly state?: EasyServerState;
  readonly stateStatus: "ok" | "empty" | "error";
  readonly pluginStatuses: readonly PluginStatus[];
  readonly daemonStatus: DiagnosticsReport["daemon"];
  readonly sshAvailable: boolean;
  readonly sshKeyscanAvailable: boolean;
  readonly easyserverVersion?: string;
  readonly nodeVersion?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

export interface DiagnosticsCollectionOptions {
  readonly stateFile: string;
  readonly daemonFile: string;
  readonly pluginImporter?: PluginImporter;
  readonly commandProbe?: (command: string) => boolean;
}

export async function collectDiagnostics(
  options: DiagnosticsCollectionOptions,
): Promise<DiagnosticsReport> {
  const store = new JsonStateStore(options.stateFile);
  let state: EasyServerState | undefined;
  let stateStatus: DiagnosticsBuildInput["stateStatus"] = "error";
  let pluginStatuses: readonly PluginStatus[] = [];

  try {
    state = await store.read();
    stateStatus = state.plugins.length === 0 && (state.instances?.length ?? 0) === 0
      ? "empty"
      : "ok";

    const host = new PluginHost(
      new ProviderRegistry(),
      options.pluginImporter,
    );
    const enabled = state.plugins.filter((plugin) => plugin.enabled);
    await host.load(
      enabled.map((plugin) => ({
        source: plugin.source,
        ...(plugin.credentials === undefined
          ? {}
          : { credentials: plugin.credentials }),
      })),
    );
    pluginStatuses = [
      ...host.listPlugins(),
      ...state.plugins
        .filter((plugin) => !plugin.enabled)
        .map<PluginStatus>((plugin) => ({
          source: plugin.source,
          state: "disabled",
        })),
    ];
  } catch {
    // Diagnostics must remain safe and useful even when Local State cannot be read.
  }

  const probe = options.commandProbe ?? commandAvailable;
  return createDiagnosticsReport({
    state,
    stateStatus,
    pluginStatuses,
    daemonStatus: await diagnoseDaemon(options.daemonFile),
    sshAvailable: probe("ssh"),
    sshKeyscanAvailable: probe("ssh-keyscan"),
  });
}

export function createDiagnosticsReport(
  input: DiagnosticsBuildInput,
): DiagnosticsReport {
  const state = input.state;
  return {
    schemaVersion: 1,
    easyserver: {
      version: input.easyserverVersion ?? EASYSERVER_VERSION,
    },
    runtime: {
      node: input.nodeVersion ?? process.version,
      platform: input.platform ?? process.platform,
      arch: input.arch ?? process.arch,
    },
    state: {
      status: input.stateStatus,
      configuredPlugins: state?.plugins.length ?? 0,
      credentialBindings:
        state?.plugins.reduce(
          (count, plugin) => count + (plugin.credentials?.length ?? 0),
          0,
        ) ?? 0,
      instanceBindings: state?.instances?.length ?? 0,
    },
    plugins: input.pluginStatuses.map((status, index) =>
      sanitizePluginStatus(status, index),
    ),
    daemon: input.daemonStatus,
    access: {
      ssh: input.sshAvailable ? "available" : "unavailable",
      sshKeyscan: input.sshKeyscanAvailable ? "available" : "unavailable",
    },
  };
}

async function diagnoseDaemon(
  descriptorPath: string,
): Promise<DiagnosticsReport["daemon"]> {
  let descriptor;
  try {
    descriptor = await readLocalDaemonDescriptor(descriptorPath);
  } catch {
    return { status: "invalid" };
  }

  if (descriptor === undefined) {
    return { status: "stopped" };
  }

  const client = new LocalDaemonClient(descriptor.address, descriptor.authToken);
  try {
    await client.ping();
  } catch {
    return { status: "unreachable" };
  }

  try {
    return {
      status: "running",
      sessionCount: (await client.listSessions()).length,
    };
  } catch {
    return { status: "running" };
  }
}

function sanitizePluginStatus(
  status: PluginStatus,
  index: number,
): DiagnosticsPluginStatus {
  return {
    identity:
      status.pluginId ?? safePackageSource(status.source) ?? `configured-plugin-${index + 1}`,
    state: status.state,
    ...(status.version === undefined ? {} : { version: status.version }),
    ...(status.providerId === undefined ? {} : { providerId: status.providerId }),
    ...(status.state !== "failed"
      ? {}
      : { failure: classifyPluginFailure(status.error) }),
  };
}

function safePackageSource(source: string): string | undefined {
  if (isAbsolute(source) || source.startsWith(".") || source.startsWith("file:")) {
    return undefined;
  }
  return /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(source)
    ? source
    : undefined;
}

function classifyPluginFailure(
  error: string | undefined,
): DiagnosticsPluginStatus["failure"] {
  if (error?.includes("requires EasyServer") || error?.includes("requires plugin SDK")) {
    return "incompatible";
  }
  if (error?.includes("timed out")) {
    return "timeout";
  }
  return "load-failed";
}

function commandAvailable(command: string): boolean {
  const result = spawnSync(command, ["-V"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 2_000,
  });
  return result.error === undefined || (result.error as NodeJS.ErrnoException).code !== "ENOENT";
}
