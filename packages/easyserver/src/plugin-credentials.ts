import type { SecretReference } from "@easyai101/easyserver-plugin-sdk";
import type { SecretStore } from "./secret-store.js";
import {
  JsonStateStore,
  type EasyServerState,
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
  findPlugin((await stateStore.read()).plugins, source);

  const newSecretRef = await secretStore.create(secret);
  let previousSecretRef: SecretReference | undefined;

  try {
    await stateStore.update((state) => {
      const index = findPlugin(state.plugins, source);
      const plugin = state.plugins[index];
      previousSecretRef = plugin.credentials?.find(
        (credential) => credential.name === name,
      )?.secretRef;
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
    const referenced = await secretReferenceState(stateStore, newSecretRef);
    if (referenced === false) {
      try {
        await secretStore.delete(newSecretRef);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Failed to persist provider credential and clean up the unused new secret",
        );
      }
    }
    throw error;
  }

  return {
    previousSecretRemoved: await removeSecretIfUnused(
      stateStore,
      secretStore,
      previousSecretRef,
    ),
  };
}

export async function removePluginCredential(
  stateStore: JsonStateStore,
  secretStore: SecretStore,
  source: string,
  name: string,
): Promise<CredentialUpdateResult> {
  assertCredentialName(name);
  let previousSecretRef: SecretReference | undefined;

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
    previousSecretRemoved: await removeSecretIfUnused(
      stateStore,
      secretStore,
      previousSecretRef,
    ),
  };
}

async function removeSecretIfUnused(
  stateStore: JsonStateStore,
  secretStore: SecretStore,
  ref: SecretReference | undefined,
): Promise<boolean> {
  if (ref === undefined) {
    return true;
  }
  const referenced = await secretReferenceState(stateStore, ref);
  if (referenced !== false) {
    return false;
  }
  return secretStore.delete(ref).catch(() => false);
}

async function secretReferenceState(
  stateStore: JsonStateStore,
  ref: SecretReference,
): Promise<boolean | undefined> {
  try {
    return stateReferencesSecret(await stateStore.read(), ref);
  } catch {
    // Failure to prove a secret unused must fail safe: retaining an orphan is
    // preferable to deleting a secret that committed state may still reference.
    return undefined;
  }
}

function stateReferencesSecret(state: EasyServerState, ref: SecretReference): boolean {
  return state.plugins.some((plugin) =>
    plugin.credentials?.some((credential) => credential.secretRef === ref),
  );
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
