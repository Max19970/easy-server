import type { SecretStore } from "./secret-store.js";
import {
  JsonStateStore,
  type PluginRegistration,
} from "./state-store.js";

export interface CredentialUpdateResult {
  readonly previousSecretRemoved: boolean;
}

export async function setPluginCredential(
  stateStore: JsonStateStore,
  secretStore: SecretStore,
  source: string,
  name: string,
  secret: string,
): Promise<CredentialUpdateResult> {
  assertCredentialName(name);
  let previousSecretRef: Awaited<ReturnType<SecretStore["create"]>> | undefined;
  let newSecretRef: Awaited<ReturnType<SecretStore["create"]>> | undefined;

  try {
    await stateStore.update(async (state) => {
      const index = findPlugin(state.plugins, source);
      const plugin = state.plugins[index];
      previousSecretRef = plugin.credentials?.find(
        (credential) => credential.name === name,
      )?.secretRef;
      newSecretRef = await secretStore.create(secret);
      const credentials = [
        ...(plugin.credentials ?? []).filter(
          (credential) => credential.name !== name,
        ),
        { name, secretRef: newSecretRef },
      ];
      const plugins = state.plugins.map<PluginRegistration>(
        (candidate, candidateIndex) =>
          candidateIndex === index ? { ...candidate, credentials } : candidate,
      );
      return { ...state, plugins };
    });
  } catch (error) {
    if (newSecretRef !== undefined) {
      try {
        await secretStore.delete(newSecretRef);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Failed to persist provider credential and clean up the new secret",
        );
      }
    }
    throw error;
  }

  return {
    previousSecretRemoved:
      previousSecretRef === undefined
        ? true
        : await secretStore.delete(previousSecretRef).catch(() => false),
  };
}

export async function removePluginCredential(
  stateStore: JsonStateStore,
  secretStore: SecretStore,
  source: string,
  name: string,
): Promise<CredentialUpdateResult> {
  assertCredentialName(name);
  let previousSecretRef: Awaited<ReturnType<SecretStore["create"]>> | undefined;

  await stateStore.update((state) => {
    const index = findPlugin(state.plugins, source);
    const plugin = state.plugins[index];
    const previous = plugin.credentials?.find(
      (credential) => credential.name === name,
    );
    if (previous === undefined) {
      throw new Error(`Plugin credential is not configured: ${name}`);
    }
    previousSecretRef = previous.secretRef;

    const remaining = (plugin.credentials ?? []).filter(
      (credential) => credential.name !== name,
    );
    const plugins = state.plugins.map<PluginRegistration>(
      (candidate, candidateIndex) => {
        if (candidateIndex !== index) {
          return candidate;
        }
        return remaining.length === 0
          ? withoutCredentials(candidate)
          : { ...candidate, credentials: remaining };
      },
    );
    return { ...state, plugins };
  });

  return {
    previousSecretRemoved:
      previousSecretRef === undefined
        ? true
        : await secretStore.delete(previousSecretRef).catch(() => false),
  };
}

function findPlugin(plugins: readonly PluginRegistration[], source: string): number {
  const index = plugins.findIndex((plugin) => plugin.source === source);
  if (index < 0) {
    throw new Error(`Plugin source is not configured: ${source}`);
  }
  return index;
}

function withoutCredentials(plugin: PluginRegistration): PluginRegistration {
  const { credentials: _credentials, ...rest } = plugin;
  return rest;
}

function assertCredentialName(name: string): void {
  if (name.trim().length === 0) {
    throw new TypeError("plugin credential name must be non-empty");
  }
}
