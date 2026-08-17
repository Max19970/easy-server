import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  rmdir,
} from "node:fs/promises";
import { join } from "node:path";

const OWNER_SCHEMA_VERSION = 1;
const OWNER_SUFFIX = ".owner.json";
const ABANDONED_SUFFIX = ".abandoned";
const CREDENTIAL_PREFIX = "credential-";
// PowerShell startup can exceed five seconds on a contended Windows host/CI runner.
// Keep the identity check bounded, but give the fail-closed query enough time to complete.
const WINDOWS_PROCESS_QUERY_TIMEOUT_MS = 15_000;
const CURRENT_OWNER_INSPECTION_ATTEMPTS = 2;
let cachedCurrentOwner: CredentialOwnerRecord | undefined;

interface CredentialOwnerRecord {
  readonly schemaVersion: 1;
  readonly platform: NodeJS.Platform;
  readonly pid: number;
  readonly processIdentity: string;
}

interface CredentialMaterialPaths {
  readonly id: string;
  readonly directory: string;
  readonly ownerPath: string;
  readonly abandonedPath: string;
}

interface ProcessInspectionRunning {
  readonly state: "running";
  readonly identity: string;
}

interface ProcessInspectionMissing {
  readonly state: "missing";
}

interface ProcessInspectionUnknown {
  readonly state: "unknown";
}

type ProcessInspection =
  | ProcessInspectionRunning
  | ProcessInspectionMissing
  | ProcessInspectionUnknown;

export interface SshCredentialMaterialScope {
  readonly directory: string;
  cleanup(): Promise<void>;
}

export interface SshCredentialMaterialManagerOptions {
  readonly root: string;
  secureDirectory(path: string, signal?: AbortSignal): Promise<void>;
}

export class SshCredentialMaterialManager {
  readonly #root: string;
  readonly #secureDirectory: (
    path: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  #initializePromise: Promise<void> | undefined;

  constructor(options: SshCredentialMaterialManagerOptions) {
    this.#root = options.root;
    this.#secureDirectory = options.secureDirectory;
  }

  initialize(): Promise<void> {
    this.#initializePromise ??= this.#initialize();
    return this.#initializePromise;
  }

  async create(signal?: AbortSignal): Promise<SshCredentialMaterialScope> {
    await this.initialize();
    await this.#ensureRoot(signal);
    await this.#scavenge(signal);

    const owner = await currentOwner(signal);
    const paths = credentialMaterialPaths(this.#root, `${CREDENTIAL_PREFIX}${randomUUID()}`);
    await writeOwner(paths.ownerPath, owner);

    try {
      await mkdir(paths.directory, { mode: 0o700 });
      await this.#secureDirectory(paths.directory, signal);
    } catch (error) {
      await removeCredentialDirectory(paths.directory).catch(() => undefined);
      await removeMetadata(paths).catch(() => undefined);
      await removeEmptyRoot(this.#root);
      throw error;
    }

    let cleanupPromise: Promise<void> | undefined;
    return {
      directory: paths.directory,
      cleanup: () => {
        cleanupPromise ??= cleanupCredentialMaterial(paths, this.#root);
        return cleanupPromise;
      },
    };
  }

  async #initialize(): Promise<void> {
    if (!(await existingDirectory(this.#root))) {
      return;
    }
    await this.#secureDirectory(this.#root);
    await this.#scavenge();
    await removeEmptyRoot(this.#root);
  }

  async #ensureRoot(signal?: AbortSignal): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await this.#secureDirectory(this.#root, signal);
  }

  async #scavenge(signal?: AbortSignal): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.#root, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return;
      }
      throw error;
    }

    const ids = new Set<string>();
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const id = metadataCredentialId(entry.name);
      if (id !== undefined) {
        ids.add(id);
      }
    }

    for (const id of ids) {
      const paths = credentialMaterialPaths(this.#root, id);
      if (await fileExists(paths.abandonedPath)) {
        await scavengeCredentialMaterial(paths);
        continue;
      }

      const owner = await readOwner(paths.ownerPath);
      if (owner === undefined || owner.platform !== process.platform) {
        // Legacy, corrupt or unverifiable metadata has no safe deletion authority.
        continue;
      }

      const inspection = await inspectProcess(owner.pid, signal);
      if (inspection.state === "unknown") {
        continue;
      }
      if (
        inspection.state === "missing" ||
        inspection.identity !== owner.processIdentity
      ) {
        await scavengeCredentialMaterial(paths);
      }
    }
  }
}

async function cleanupCredentialMaterial(
  paths: CredentialMaterialPaths,
  root: string,
): Promise<void> {
  // Persist deletion authority outside the recursive-delete target before rm
  // starts. A crash at any point during rm therefore remains recoverable.
  await writeAbandoned(paths.abandonedPath);
  await removeCredentialDirectory(paths.directory);
  await removeMetadata(paths);
  await removeEmptyRoot(root);
}

async function scavengeCredentialMaterial(
  paths: CredentialMaterialPaths,
): Promise<void> {
  await removeCredentialDirectory(paths.directory);
  await removeMetadata(paths);
}

async function removeCredentialDirectory(directory: string): Promise<void> {
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 4 : 1,
    retryDelay: 25,
  });
}

async function removeMetadata(paths: CredentialMaterialPaths): Promise<void> {
  await rm(paths.ownerPath, { force: true });
  await rm(paths.abandonedPath, { force: true });
}

async function removeEmptyRoot(root: string): Promise<void> {
  try {
    await rmdir(root);
  } catch (error) {
    if (
      !isErrno(error, "ENOENT") &&
      !isErrno(error, "ENOTEMPTY") &&
      !isErrno(error, "EEXIST")
    ) {
      throw error;
    }
  }
}

async function writeOwner(
  path: string,
  owner: CredentialOwnerRecord,
): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

async function writeAbandoned(path: string): Promise<void> {
  try {
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile("abandoned\n", "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    if (!isErrno(error, "EEXIST")) {
      throw error;
    }
  }
}

async function readOwner(path: string): Promise<CredentialOwnerRecord | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return undefined;
    }
    return undefined;
  }

  try {
    const value = JSON.parse(text) as Partial<CredentialOwnerRecord>;
    if (
      value.schemaVersion !== OWNER_SCHEMA_VERSION ||
      typeof value.platform !== "string" ||
      !Number.isInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.processIdentity !== "string" ||
      value.processIdentity.length === 0
    ) {
      return undefined;
    }
    return value as CredentialOwnerRecord;
  } catch {
    return undefined;
  }
}

function credentialMaterialPaths(
  root: string,
  id: string,
): CredentialMaterialPaths {
  return {
    id,
    directory: join(root, id),
    ownerPath: join(root, `${id}${OWNER_SUFFIX}`),
    abandonedPath: join(root, `${id}${ABANDONED_SUFFIX}`),
  };
}

function metadataCredentialId(name: string): string | undefined {
  const suffix = name.endsWith(OWNER_SUFFIX)
    ? OWNER_SUFFIX
    : name.endsWith(ABANDONED_SUFFIX)
      ? ABANDONED_SUFFIX
      : undefined;
  if (suffix === undefined) {
    return undefined;
  }
  const id = name.slice(0, -suffix.length);
  return id.startsWith(CREDENTIAL_PREFIX) && id.length > CREDENTIAL_PREFIX.length
    ? id
    : undefined;
}

async function currentOwner(signal?: AbortSignal): Promise<CredentialOwnerRecord> {
  signal?.throwIfAborted();
  if (cachedCurrentOwner !== undefined) {
    return cachedCurrentOwner;
  }

  if (!supportsVerifiedProcessIdentity()) {
    // Unqualified platforms retain normal process-scope cleanup. They do not
    // gain crash-scavenging authority until an OS-stable identity is defined.
    cachedCurrentOwner = {
      schemaVersion: OWNER_SCHEMA_VERSION,
      platform: process.platform,
      pid: process.pid,
      processIdentity: `unverified:${process.pid}:${Date.now()}`,
    };
    return cachedCurrentOwner;
  }

  for (let attempt = 0; attempt < CURRENT_OWNER_INSPECTION_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    const inspection = await inspectProcess(process.pid, signal);
    if (inspection.state === "running") {
      cachedCurrentOwner = {
        schemaVersion: OWNER_SCHEMA_VERSION,
        platform: process.platform,
        pid: process.pid,
        processIdentity: inspection.identity,
      };
      return cachedCurrentOwner;
    }
    if (inspection.state === "missing") {
      break;
    }
  }

  throw new Error(
    "Unable to establish stable process ownership for temporary SSH credentials",
  );
}

function supportsVerifiedProcessIdentity(): boolean {
  return process.platform === "win32" || process.platform === "linux";
}

async function inspectProcess(
  pid: number,
  signal?: AbortSignal,
): Promise<ProcessInspection> {
  if (process.platform === "win32") {
    return inspectWindowsProcess(pid, signal);
  }
  if (process.platform === "linux") {
    return inspectLinuxProcess(pid);
  }
  return { state: "unknown" };
}

async function inspectWindowsProcess(
  pid: number,
  signal?: AbortSignal,
): Promise<ProcessInspection> {
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = [
    "try {",
    `$p = Get-Process -Id ${pid} -ErrorAction Stop;`,
    "$ticks = $p.StartTime.ToUniversalTime().Ticks;",
    "[Console]::Out.Write('RUNNING:' + $ticks);",
    "} catch [Microsoft.PowerShell.Commands.ProcessCommandException] {",
    "[Console]::Out.Write('MISSING');",
    "} catch {",
    "[Console]::Out.Write('UNKNOWN');",
    "}",
  ].join(" ");

  try {
    const stdout = await execFileText(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
      ],
      signal,
    );
    const output = stdout.trim();
    if (output === "MISSING") {
      return { state: "missing" };
    }
    if (output === "UNKNOWN") {
      return { state: "unknown" };
    }
    if (output.startsWith("RUNNING:")) {
      const identity = output.slice("RUNNING:".length);
      return identity.length === 0
        ? { state: "unknown" }
        : { state: "running", identity: `windows:${identity}` };
    }
    return { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
}

async function inspectLinuxProcess(pid: number): Promise<ProcessInspection> {
  try {
    const [statText, bootId] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    ]);
    const closeParen = statText.lastIndexOf(")");
    if (closeParen < 0) {
      return { state: "unknown" };
    }
    const fields = statText.slice(closeParen + 1).trim().split(/\s+/u);
    const startTicks = fields[19];
    if (startTicks === undefined || !/^\d+$/u.test(startTicks)) {
      return { state: "unknown" };
    }
    return {
      state: "running",
      identity: `linux:${bootId.trim()}:${startTicks}`,
    };
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { state: "missing" };
    }
    return { state: "unknown" };
  }
}

function execFileText(
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: WINDOWS_PROCESS_QUERY_TIMEOUT_MS,
        maxBuffer: 16_384,
        signal,
      },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function existingDirectory(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory()) {
      throw new Error(`Temporary SSH credential root is not a directory: ${path}`);
    }
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
