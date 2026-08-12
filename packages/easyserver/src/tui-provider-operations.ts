import type { PluginImporter } from "./plugin-host.js";
import { PluginOperations } from "./plugin-operations.js";
import { OsKeyringSecretStore, type SecretStore } from "./secret-store.js";
import { JsonStateStore } from "./state-store.js";
import {
  resolveHostRuntimePaths,
  type HostRuntimePaths,
} from "./host-runtime.js";

export type TuiProviderMutation = {
  readonly kind: "add-plugin";
  readonly source: string;
};

export type TuiProviderMutationRunner = (
  mutation: TuiProviderMutation,
) => Promise<void>;

export interface TuiProviderMutationDependencies {
  readonly stateStore?: JsonStateStore;
  readonly secretStore?: SecretStore;
  readonly pluginImporter?: PluginImporter;
}

export function createDefaultTuiProviderMutationRunner(
  paths: HostRuntimePaths = resolveHostRuntimePaths(),
  dependencies: TuiProviderMutationDependencies = {},
): TuiProviderMutationRunner {
  const operations = new PluginOperations(
    dependencies.stateStore ?? new JsonStateStore(paths.stateFile),
    dependencies.secretStore ?? new OsKeyringSecretStore(),
    dependencies.pluginImporter,
  );

  return async (mutation) => {
    if (mutation.kind === "add-plugin") {
      await operations.add(mutation.source);
    }
  };
}
