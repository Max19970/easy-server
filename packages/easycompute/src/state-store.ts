import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  parseSecretReference,
  type SecretReference,
} from "@easycompute/plugin-sdk";

export interface ProviderCredentialBinding {
  readonly name: string;
  readonly secretRef: SecretReference;
}

export interface PluginRegistration {
  readonly source: string;
  readonly enabled: boolean;
  readonly credentials?: readonly ProviderCredentialBinding[];
}

export interface EasyComputeState {
  readonly version: 1;
  readonly plugins: readonly PluginRegistration[];
}

export class JsonStateStore {
  constructor(
    readonly path: string,
    private readonly replace: typeof rename = rename,
  ) {}

  async read(): Promise<EasyComputeState> {
    let text: string;

    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return emptyState();
      }

      throw error;
    }

    let value: unknown;

    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid EasyCompute state file: ${this.path}`, {
        cause: error,
      });
    }

    return parseState(value);
  }

  async write(state: EasyComputeState): Promise<void> {
    const parsed = parseState(state);
    const directory = dirname(this.path);
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let file: Awaited<ReturnType<typeof open>> | undefined;

    await mkdir(directory, { recursive: true });

    try {
      file = await open(temporaryPath, "wx", 0o600);
      await file.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      await file.sync();
      await file.close();
      file = undefined;
      await this.replace(temporaryPath, this.path);
    } finally {
      await file?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

function emptyState(): EasyComputeState {
  return { version: 1, plugins: [] };
}

function parseState(value: unknown): EasyComputeState {
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

  return { version: 1, plugins };
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

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
