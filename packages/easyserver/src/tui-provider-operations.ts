import type { PluginImporter } from "./plugin-host.js";
import { PluginOperations } from "./plugin-operations.js";
import { OsKeyringSecretStore, type SecretStore } from "./secret-store.js";
import { JsonStateStore } from "./state-store.js";
import {
  resolveHostRuntimePaths,
  type HostRuntimePaths,
} from "./host-runtime.js";

export type TuiProviderMutation =
  | {
      readonly kind: "add-plugin";
      readonly source: string;
    }
  | {
      readonly kind: "set-enabled";
      readonly source: string;
      readonly enabled: boolean;
    }
  | {
      readonly kind: "set-credential";
      readonly source: string;
      readonly name: string;
      readonly secret: string;
    }
  | {
      readonly kind: "remove-credential";
      readonly source: string;
      readonly name: string;
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
      return;
    }
    if (mutation.kind === "set-enabled") {
      await operations.setEnabled(mutation.source, mutation.enabled);
      return;
    }
    if (mutation.kind === "set-credential") {
      await operations.setCredential(
        mutation.source,
        mutation.name,
        mutation.secret,
      );
      return;
    }
    await operations.removeCredential(mutation.source, mutation.name);
  };
}
