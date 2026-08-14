import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  parseSecretReference,
  type SecretReference,
} from "@easyai101/easyserver-plugin-sdk";

const DEFAULT_SERVICE = "EasyServer";
const require = createRequire(import.meta.url);

export interface SecretStore {
  create(secret: string, signal?: AbortSignal): Promise<SecretReference>;
  get(ref: SecretReference, signal?: AbortSignal): Promise<string | undefined>;
  delete(ref: SecretReference, signal?: AbortSignal): Promise<boolean>;
}

export class InMemorySecretStore implements SecretStore {
  readonly #secrets = new Map<SecretReference, string>();

  async create(secret: string): Promise<SecretReference> {
    assertSecret(secret);
    const ref = newSecretReference();
    this.#secrets.set(ref, secret);
    return ref;
  }

  async get(ref: SecretReference): Promise<string | undefined> {
    return this.#secrets.get(validateSecretReference(ref));
  }

  async delete(ref: SecretReference): Promise<boolean> {
    return this.#secrets.delete(validateSecretReference(ref));
  }
}

interface KeyringEntry {
  setPassword(secret: string, signal?: AbortSignal): Promise<void>;
  getPassword(signal?: AbortSignal): Promise<string | undefined | null>;
  deleteCredential(signal?: AbortSignal): Promise<boolean>;
}

type KeyringEntryFactory = (service: string, account: string) => KeyringEntry;

export class OsKeyringSecretStore implements SecretStore {
  readonly #service: string;
  readonly #entryFactory: KeyringEntryFactory;

  constructor(
    service = DEFAULT_SERVICE,
    entryFactory: KeyringEntryFactory = defaultKeyringEntryFactory,
  ) {
    this.#service = service;
    this.#entryFactory = entryFactory;
  }

  async create(
    secret: string,
    signal?: AbortSignal,
  ): Promise<SecretReference> {
    assertSecret(secret);
    const ref = newSecretReference();
    const entry = this.#entry(ref);

    try {
      await entry.setPassword(secret, signal);
      return ref;
    } catch (error) {
      await entry.deleteCredential().catch(() => false);
      throw error;
    }
  }

  async get(
    ref: SecretReference,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    return (await this.#entry(validateSecretReference(ref)).getPassword(signal)) ?? undefined;
  }

  async delete(
    ref: SecretReference,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.#entry(validateSecretReference(ref)).deleteCredential(signal);
  }

  #entry(ref: SecretReference): KeyringEntry {
    return this.#entryFactory(this.#service, ref);
  }
}

function defaultKeyringEntryFactory(service: string, account: string): KeyringEntry {
  const { AsyncEntry } = require("@napi-rs/keyring") as typeof import("@napi-rs/keyring");
  return new AsyncEntry(service, account);
}

function newSecretReference(): SecretReference {
  return parseSecretReference(`secret:${randomUUID()}`);
}

function validateSecretReference(ref: SecretReference): SecretReference {
  return parseSecretReference(ref);
}

function assertSecret(secret: string): void {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new TypeError("secret must be a non-empty string");
  }
}
