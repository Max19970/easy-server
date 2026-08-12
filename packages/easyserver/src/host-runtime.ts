import { homedir } from "node:os";
import { join } from "node:path";
import { AccessAdapterRegistry } from "./access-adapter-registry.js";
import { ComputeManager } from "./compute-manager.js";
import { ConnectionGateway } from "./connection-gateway.js";
import {
  PluginHost,
  type PluginImporter,
} from "./plugin-host.js";
import { PluginOperations } from "./plugin-operations.js";
import { ProviderFeatureHost } from "./provider-feature-host.js";
import { ProviderRegistry } from "./provider-registry.js";
import {
  OsKeyringSecretStore,
  type SecretStore,
} from "./secret-store.js";
import { OpenSshAccessAdapter } from "./ssh-access-adapter.js";
import {
  JsonStateStore,
  type EasyServerState,
  type PluginRegistration,
} from "./state-store.js";

export interface HostRuntimePaths {
  readonly stateFile: string;
  readonly daemonFile: string;
}

export interface HostRuntimeDependencies {
  readonly stateStore?: JsonStateStore;
  readonly secretStore?: SecretStore;
  readonly providerRegistry?: ProviderRegistry;
  readonly providerFeatureHost?: ProviderFeatureHost;
  readonly sshAdapter?: OpenSshAccessAdapter;
  readonly pluginImporter?: PluginImporter;
}

export interface CreateHostRuntimeOptions extends HostRuntimeDependencies {
  readonly paths?: HostRuntimePaths;
  readonly state?: EasyServerState;
  readonly loadConfiguredPlugins?: boolean;
}

export class HostRuntime {
  constructor(
    readonly paths: HostRuntimePaths,
    readonly state: EasyServerState,
    readonly stateStore: JsonStateStore,
    readonly secretStore: SecretStore,
    readonly providerRegistry: ProviderRegistry,
    readonly providerFeatureHost: ProviderFeatureHost,
    readonly pluginHost: PluginHost,
    readonly pluginOperations: PluginOperations,
    readonly accessAdapters: AccessAdapterRegistry,
    readonly sshAdapter: OpenSshAccessAdapter,
    readonly computeManager: ComputeManager,
    readonly connectionGateway: ConnectionGateway,
  ) {}
}

export async function createHostRuntime(
  options: CreateHostRuntimeOptions = {},
): Promise<HostRuntime> {
  const defaultPaths = resolveHostRuntimePaths();
  const stateStore =
    options.stateStore ??
    new JsonStateStore(options.paths?.stateFile ?? defaultPaths.stateFile);
  const paths =
    options.paths ?? { ...defaultPaths, stateFile: stateStore.path };
  const secretStore = options.secretStore ?? new OsKeyringSecretStore();
  const providerRegistry = options.providerRegistry ?? new ProviderRegistry();
  const providerFeatureHost =
    options.providerFeatureHost ?? new ProviderFeatureHost();
  const sshAdapter = options.sshAdapter ?? new OpenSshAccessAdapter();
  const accessAdapters = new AccessAdapterRegistry([sshAdapter]);
  const pluginHost = new PluginHost(
    providerRegistry,
    options.pluginImporter,
    providerFeatureHost,
  );
  const state = options.state ?? (await stateStore.read());

  if (options.loadConfiguredPlugins !== false) {
    await pluginHost.load(configuredPluginLoads(state.plugins), secretStore);
  }

  return new HostRuntime(
    paths,
    state,
    stateStore,
    secretStore,
    providerRegistry,
    providerFeatureHost,
    pluginHost,
    new PluginOperations(stateStore, secretStore, options.pluginImporter),
    accessAdapters,
    sshAdapter,
    new ComputeManager(providerRegistry, stateStore),
    new ConnectionGateway(
      providerRegistry,
      accessAdapters,
      stateStore,
      secretStore,
    ),
  );
}

export function resolveHostRuntimePaths(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): HostRuntimePaths {
  return {
    stateFile:
      env.EASYSERVER_STATE_FILE ?? join(homeDirectory, ".easyserver", "state.json"),
    daemonFile:
      env.EASYSERVER_DAEMON_FILE ?? join(homeDirectory, ".easyserver", "daemon.json"),
  };
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
