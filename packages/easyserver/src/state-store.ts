import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  parseSecretReference,
  type SecretReference,
} from "@easyai101/easyserver-plugin-sdk";
import {
  acquireFilesystemLock,
  FilesystemLockTimeoutError,
  type FilesystemLockLease,
} from "./filesystem-lock.js";

export interface ProviderCredentialBinding {
  readonly name: string;
  readonly secretRef: SecretReference;
}

export interface PluginRegistration {
  readonly source: string;
  readonly enabled: boolean;
  readonly credentials?: readonly ProviderCredentialBinding[];
}

export interface InstanceBinding {
  readonly id: string;
  readonly providerId: string;
  readonly providerExternalId: string;
}

export interface EasyServerState {
  readonly version: 1;
  readonly plugins: readonly PluginRegistration[];
  readonly instances?: readonly InstanceBinding[];
}

export class JsonStateStore {
  constructor(
    readonly path: string,
    private readonly replace: typeof rename = rename,
  ) {}

  async read(): Promise<EasyServerState> {
    const primary = await readStateFile(this.path);
    if (primary.kind === "valid") {
      return primary.state;
    }

    const recoveryPath = `${this.path}.recovery`;
    const recovery = await readStateFile(recoveryPath);
    if (recovery.kind === "valid") {
      return recovery.state;
    }

    if (primary.kind === "missing" && recovery.kind === "missing") {
      return emptyState();
    }

    throw stateRecoveryError(this.path, primary, recovery);
  }

  async update(
    mutate: (
      state: EasyServerState,
    ) => EasyServerState | Promise<EasyServerState>,
  ): Promise<void> {
    const lock = await acquireStateLock(this.path);
    try {
      const state = await this.read();
      const next = await mutate(state);
      if (next !== state) {
        await lock.assertOwned();
        await this.#writeUnlocked(next);
      }
    } finally {
      await lock.release();
    }
  }

  async write(state: EasyServerState): Promise<void> {
    const lock = await acquireStateLock(this.path);
    try {
      await lock.assertOwned();
      await this.#writeUnlocked(state);
    } finally {
      await lock.release();
    }
  }

  async #writeUnlocked(state: EasyServerState): Promise<void> {
    const parsed = parseState(state);
    await this.#writeFileAtomically(this.path, parsed);
    await this.#writeFileAtomically(`${this.path}.recovery`, parsed);
  }

  async #writeFileAtomically(path: string, state: EasyServerState): Promise<void> {
    const directory = dirname(path);
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let file: Awaited<ReturnType<typeof open>> | undefined;

    await mkdir(directory, { recursive: true });

    try {
      file = await open(temporaryPath, "wx", 0o600);
      await file.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await file.sync();
      await file.close();
      file = undefined;
      await this.replace(temporaryPath, path);
    } finally {
      await file?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

async function acquireStateLock(path: string): Promise<FilesystemLockLease> {
  const lockPath = `${path}.lock`;
  try {
    return await acquireFilesystemLock(lockPath);
  } catch (error) {
    if (error instanceof FilesystemLockTimeoutError) {
      throw new Error(`Timed out waiting for EasyServer state lock: ${lockPath}`, {
        cause: error,
      });
    }
    throw error;
  }
}

type StateFileRead =
  | { readonly kind: "valid"; readonly state: EasyServerState }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly error: Error };

async function readStateFile(path: string): Promise<StateFileRead> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { kind: "missing" };
    }
    throw error;
  }

  try {
    return { kind: "valid", state: parseState(JSON.parse(text)) };
  } catch (error) {
    return {
      kind: "invalid",
      error: new Error(`Invalid EasyServer state file: ${path}`, {
        cause: error,
      }),
    };
  }
}

function stateRecoveryError(
  path: string,
  primary: StateFileRead,
  recovery: StateFileRead,
): Error {
  const primaryDescription =
    primary.kind === "missing"
      ? `primary state is missing: ${path}`
      : primary.kind === "invalid"
        ? primary.error.message
        : "primary state is valid";
  const recoveryPath = `${path}.recovery`;
  const recoveryDescription =
    recovery.kind === "missing"
      ? `recovery state is missing: ${recoveryPath}`
      : recovery.kind === "invalid"
        ? recovery.error.message
        : "recovery state is valid";
  const cause =
    primary.kind === "invalid"
      ? primary.error
      : recovery.kind === "invalid"
        ? recovery.error
        : undefined;

  return new Error(
    `Unable to recover EasyServer state: ${primaryDescription}; ${recoveryDescription}. Restore a valid state.json or state.json.recovery file; EasyServer will not reset Local State automatically.`,
    cause === undefined ? undefined : { cause },
  );
}

function emptyState(): EasyServerState {
  return { version: 1, plugins: [] };
}

function parseState(value: unknown): EasyServerState {
  const state = expectRecord(value, "state");

  if (state.version !== 1) {
    throw new TypeError("state.version must be 1");
  }

  if (!Array.isArray(state.plugins)) {
    throw new TypeError("state.plugins must be an array");
  }

  const plugins: PluginRegistration[] = [];
  const seenSources = new Set<string>();

  for (const [index, candidate] of state.plugins.entries()) {
    const plugin = expectRecord(candidate, `state.plugins[${index}]`);
    const source = expectNonEmptyString(
      plugin.source,
      `state.plugins[${index}].source`,
    );

    if (typeof plugin.enabled !== "boolean") {
      throw new TypeError(`state.plugins[${index}].enabled must be a boolean`);
    }

    if (seenSources.has(source)) {
      throw new TypeError(`state.plugins contains duplicate source: ${source}`);
    }

    const credentials = parseCredentialBindings(
      plugin.credentials,
      `state.plugins[${index}].credentials`,
    );

    seenSources.add(source);
    plugins.push(
      credentials === undefined
        ? { source, enabled: plugin.enabled }
        : { source, enabled: plugin.enabled, credentials },
    );
  }

  const instances = parseInstanceBindings(state.instances, "state.instances");

  return instances === undefined
    ? { version: 1, plugins }
    : { version: 1, plugins, instances };
}

function parseInstanceBindings(
  value: unknown,
  path: string,
): readonly InstanceBinding[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new TypeError(`${path} must be an array`);
  }

  const bindings: InstanceBinding[] = [];
  const seenIds = new Set<string>();
  const seenProviderKeys = new Set<string>();

  for (const [index, candidate] of value.entries()) {
    const binding = expectRecord(candidate, `${path}[${index}]`);
    const id = expectNonEmptyString(binding.id, `${path}[${index}].id`);
    const providerId = expectNonEmptyString(
      binding.providerId,
      `${path}[${index}].providerId`,
    );
    const providerExternalId = expectNonEmptyString(
      binding.providerExternalId,
      `${path}[${index}].providerExternalId`,
    );

    if (!COMPUTE_INSTANCE_ID_PATTERN.test(id)) {
      throw new TypeError(`${path}[${index}].id must be instance:<uuid>`);
    }

    if (seenIds.has(id)) {
      throw new TypeError(`${path} contains duplicate id: ${id}`);
    }

    const providerKey = `${providerId}\u0000${providerExternalId}`;
    if (seenProviderKeys.has(providerKey)) {
      throw new TypeError(
        `${path} contains duplicate provider identity: ${providerId}/${providerExternalId}`,
      );
    }

    seenIds.add(id);
    seenProviderKeys.add(providerKey);
    bindings.push({ id, providerId, providerExternalId });
  }

  return bindings;
}

function parseCredentialBindings(
  value: unknown,
  path: string,
): readonly ProviderCredentialBinding[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new TypeError(`${path} must be an array`);
  }

  const bindings: ProviderCredentialBinding[] = [];
  const seenNames = new Set<string>();

  for (const [index, candidate] of value.entries()) {
    const binding = expectRecord(candidate, `${path}[${index}]`);
    const name = expectNonEmptyString(binding.name, `${path}[${index}].name`);

    if (seenNames.has(name)) {
      throw new TypeError(`${path} contains duplicate name: ${name}`);
    }

    let secretRef: SecretReference;
    try {
      secretRef = parseSecretReference(binding.secretRef);
    } catch {
      throw new TypeError(
        `${path}[${index}].secretRef must be an opaque secret reference`,
      );
    }

    seenNames.add(name);
    bindings.push({ name, secretRef });
  }

  return bindings;
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }

  return value as Record<string, unknown>;
}

function expectNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }

  return value;
}

const COMPUTE_INSTANCE_ID_PATTERN =
  /^instance:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
