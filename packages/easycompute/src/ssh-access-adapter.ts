import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, open, readFile, rm, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Duplex } from "node:stream";
import {
  hostTrustRequiredError,
  isSshAccessMethod,
  normalizedError,
  type AccessAdapter,
  type AccessChannel,
  type AccessMethod,
  type AccessSetupContext,
  type AccessTransportSession,
  type HostTrustRequiredError,
  type OperationContext,
  type TcpForwardTarget,
} from "@easycompute/plugin-sdk";

interface CommandSpec {
  readonly executable: string;
  readonly prefixArgs?: readonly string[];
}

export interface OpenSshAccessAdapterOptions {
  readonly knownHostsPath?: string;
  readonly sshCommand?: CommandSpec;
  readonly keyscanCommand?: CommandSpec;
  readonly icaclsCommand?: CommandSpec;
}

interface HostKey {
  readonly keyType: string;
  readonly key: string;
  readonly fingerprint: string;
}

interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export class OpenSshAccessAdapter implements AccessAdapter {
  readonly kind = "ssh";
  readonly #knownHostsPath: string;
  readonly #sshCommand: CommandSpec;
  readonly #keyscanCommand: CommandSpec;
  readonly #icaclsCommand: CommandSpec;

  constructor(options: OpenSshAccessAdapterOptions = {}) {
    this.#knownHostsPath =
      options.knownHostsPath ?? join(homedir(), ".easycompute", "known_hosts");
    this.#sshCommand = options.sshCommand ?? defaultOpenSshCommand("ssh.exe", "ssh");
    this.#keyscanCommand =
      options.keyscanCommand ?? defaultOpenSshCommand("ssh-keyscan.exe", "ssh-keyscan");
    this.#icaclsCommand = options.icaclsCommand ?? { executable: "icacls.exe" };
  }

  async openTcpForward(
    method: AccessMethod,
    _providerExternalId: string,
    target: TcpForwardTarget,
    context: AccessSetupContext,
  ): Promise<AccessTransportSession> {
    assertSshMethod(method);
    await this.#assertHostTrusted(method, context.signal);

    const identityFile =
      method.ssh.privateKeySecretRef === undefined
        ? undefined
        : await this.#materializePrivateKey(
            await context.resolveSecret(method.ssh.privateKeySecretRef),
            context,
          );

    return new OpenSshTransportSession(
      method,
      target,
      this.#knownHostsPath,
      identityFile,
      this.#sshCommand,
    );
  }

  async enrollHostKey(
    trust: HostTrustRequiredError,
    signal?: AbortSignal,
  ): Promise<void> {
    const scanned = await scanHostKeys(
      trust.host,
      trust.port,
      this.#keyscanCommand,
      signal,
    );
    const selected = scanned.find(
      (candidate) =>
        candidate.keyType === trust.keyType &&
        candidate.fingerprint === trust.fingerprint,
    );
    if (selected === undefined) {
      throw normalizedError(
        "authentication",
        `SSH host key changed before trust confirmation for ${trust.host}:${trust.port}`,
      );
    }

    const label = knownHostsLabel(trust.host, trust.port);
    await withKnownHostsEnrollmentLock(this.#knownHostsPath, signal, async () => {
      const known = await readKnownHostKeys(this.#knownHostsPath, label);
      if (known.some((candidate) => sameHostKey(candidate, selected))) {
        return;
      }
      if (known.length > 0) {
        throw normalizedError(
          "authentication",
          `SSH host key mismatch for ${trust.host}:${trust.port}`,
        );
      }

      const file = await open(this.#knownHostsPath, "a", 0o600);
      try {
        await file.write(`${label} ${selected.keyType} ${selected.key}\n`, undefined, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
    });
  }

  async #assertHostTrusted(
    method: AccessMethod & { readonly kind: "ssh"; readonly ssh: NonNullable<AccessMethod["ssh"]> },
    signal: AbortSignal,
  ): Promise<void> {
    const scanned = await scanHostKeys(
      method.ssh.host,
      method.ssh.port,
      this.#keyscanCommand,
      signal,
    );
    const known = await readKnownHostKeys(
      this.#knownHostsPath,
      knownHostsLabel(method.ssh.host, method.ssh.port),
    );

    if (known.length === 0) {
      const selected = preferredHostKey(scanned);
      throw hostTrustRequiredError(
        method.ssh.host,
        method.ssh.port,
        selected.keyType,
        selected.fingerprint,
      );
    }

    if (!known.some((knownKey) => scanned.some((scannedKey) => sameHostKey(knownKey, scannedKey)))) {
      throw normalizedError(
        "authentication",
        `SSH host key mismatch for ${method.ssh.host}:${method.ssh.port}`,
      );
    }
  }

  async #materializePrivateKey(
    secret: string,
    context: AccessSetupContext,
  ): Promise<string> {
    const directory = join(
      dirname(this.#knownHostsPath),
      "sessions",
      randomUUID(),
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    context.registerCleanup(() => rm(directory, { recursive: true, force: true }));
    await securePrivateDirectory(directory, this.#icaclsCommand, context.signal);

    const path = join(directory, "identity");
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(secret.endsWith("\n") ? secret : `${secret}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    if (process.platform !== "win32") {
      await chmod(path, 0o600);
    }
    return path;
  }
}

class OpenSshTransportSession implements AccessTransportSession {
  readonly #channels = new Set<AccessChannel>();
  #closed = false;

  constructor(
    private readonly method: AccessMethod & {
      readonly kind: "ssh";
      readonly ssh: NonNullable<AccessMethod["ssh"]>;
    },
    private readonly target: TcpForwardTarget,
    private readonly knownHostsPath: string,
    private readonly identityFile: string | undefined,
    private readonly sshCommand: CommandSpec,
  ) {}

  async openChannel(context: OperationContext): Promise<AccessChannel> {
    if (this.#closed) {
      throw normalizedError("plugin-failure", "SSH transport session is closed");
    }
    if (context.signal.aborted) {
      throw normalizedError("cancelled", "SSH channel opening was cancelled");
    }

    const child = spawn(
      this.sshCommand.executable,
      [
        ...(this.sshCommand.prefixArgs ?? []),
        ...buildSshArgs(
          this.method,
          this.target,
          this.knownHostsPath,
          this.identityFile,
        ),
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const onAbort = () => {
      child.kill();
    };
    context.signal.addEventListener("abort", onAbort, { once: true });
    if (context.signal.aborted) {
      onAbort();
    }
    try {
      await waitForSpawn(child, context.signal);
      if (context.signal.aborted) {
        throw normalizedError("cancelled", "SSH channel opening was cancelled");
      }
    } catch (error) {
      context.signal.removeEventListener("abort", onAbort);
      if (context.signal.aborted) {
        if (child.pid !== undefined) {
          await closeChild(child, context.signal);
        }
        throw normalizedError(
          "cancelled",
          "SSH channel opening was cancelled",
          error,
        );
      }
      throw error;
    }

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
    });

    const stream = Duplex.from({
      readable: child.stdout,
      writable: child.stdin,
    });
    stream.on("error", () => undefined);
    let closePromise: Promise<void> | undefined;
    let closing = false;

    const channel: AccessChannel = {
      stream,
      close: () => {
        if (closePromise === undefined) {
          closing = true;
          stream.destroy();
          closePromise = closeChild(child, context.signal).finally(() => {
            context.signal.removeEventListener("abort", onAbort);
            this.#channels.delete(channel);
          });
        }
        return closePromise;
      },
    };
    this.#channels.add(channel);

    child.once("close", (code) => {
      context.signal.removeEventListener("abort", onAbort);
      this.#channels.delete(channel);
      if (!closing && code !== 0 && !stream.destroyed) {
        stream.destroy(
          new Error(
            `OpenSSH channel exited with code ${code ?? "unknown"}${formatSshDiagnostic(stderr)}`,
          ),
        );
      }
    });
    child.once("error", (error) => stream.destroy(error));

    return channel;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;

    const results = await Promise.allSettled(
      [...this.#channels].map((channel) => channel.close()),
    );
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Multiple OpenSSH channels failed to close");
    }
  }
}

function assertSshMethod(
  method: AccessMethod,
): asserts method is AccessMethod & {
  readonly kind: "ssh";
  readonly ssh: NonNullable<AccessMethod["ssh"]>;
} {
  if (!isSshAccessMethod(method)) {
    throw new TypeError("OpenSSH Access Adapter requires an SSH Access Method");
  }
}

export function buildSshArgs(
  method: AccessMethod & {
    readonly kind: "ssh";
    readonly ssh: NonNullable<AccessMethod["ssh"]>;
  },
  target: TcpForwardTarget,
  knownHostsPath: string,
  identityFile?: string,
): readonly string[] {
  return [
    "-F",
    "none",
    "-W",
    formatHostPort(target.host, target.port),
    "-p",
    String(method.ssh.port),
    "-l",
    method.ssh.username,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${knownHostsPath}`,
    "-o",
    `GlobalKnownHostsFile=${nullDevice()}`,
    "-o",
    "CheckHostIP=no",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    ...(identityFile === undefined
      ? []
      : ["-o", "IdentitiesOnly=yes", "-i", identityFile]),
    method.ssh.host,
  ];
}

async function scanHostKeys(
  host: string,
  port: number,
  command: CommandSpec,
  signal?: AbortSignal,
): Promise<readonly HostKey[]> {
  let result: CommandResult;
  try {
    result = await runCommand(
      command,
      ["-T", "5", "-p", String(port), "-t", "ed25519,ecdsa,rsa", host],
      signal,
      8_000,
    );
  } catch (error) {
    if (signal?.aborted) {
      throw normalizedError("cancelled", "SSH host-key scan was cancelled", error);
    }
    if (error instanceof CommandError && error.stdout.trim().length > 0) {
      result = {
        code: error.code,
        stdout: error.stdout,
        stderr: error.stderr,
      };
    } else {
      throw normalizedError(
        "provider-unavailable",
        `Unable to read SSH host key from ${host}:${port}`,
        error,
      );
    }
  }

  const keys = parseKeyscanOutput(result.stdout);
  if (keys.length === 0) {
    throw normalizedError(
      "provider-unavailable",
      `SSH host ${host}:${port} did not present a host key`,
    );
  }
  return keys;
}

function parseKeyscanOutput(output: string): readonly HostKey[] {
  const keys: HostKey[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const fields = trimmed.split(/\s+/u);
    if (fields.length < 3) {
      continue;
    }
    keys.push(hostKey(fields[1], fields[2]));
  }
  return keys;
}

async function withKnownHostsEnrollmentLock<T>(
  path: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.enroll.lock`;
  const deadline = Date.now() + 5_000;

  for (;;) {
    if (signal?.aborted) {
      throw normalizedError("cancelled", "SSH host-key enrollment was cancelled");
    }

    let lock: FileHandle;
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw normalizedError(
          "plugin-failure",
          "Timed out waiting for SSH host-key enrollment lock",
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      continue;
    }

    try {
      if (signal?.aborted) {
        throw normalizedError("cancelled", "SSH host-key enrollment was cancelled");
      }
      return await run();
    } finally {
      try {
        await lock.close();
      } finally {
        await rm(lockPath, { force: true });
      }
    }
  }
}

async function readKnownHostKeys(
  path: string,
  label: string,
): Promise<readonly HostKey[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return [];
    }
    throw error;
  }

  const keys: HostKey[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const fields = trimmed.split(/\s+/u);
    const offset = fields[0]?.startsWith("@") ? 1 : 0;
    const hosts = fields[offset]?.split(",") ?? [];
    if (!hosts.includes(label)) {
      continue;
    }
    if (fields.length < offset + 3 || fields[0] === "@revoked") {
      throw normalizedError(
        "authentication",
        `Invalid or revoked SSH host key entry for ${label}`,
      );
    }
    keys.push(hostKey(fields[offset + 1], fields[offset + 2]));
  }
  return keys;
}

function hostKey(keyType: string, key: string): HostKey {
  const blob = Buffer.from(key, "base64");
  if (blob.length === 0) {
    throw new TypeError("SSH host key must contain base64 key material");
  }
  const fingerprint = `SHA256:${createHash("sha256")
    .update(blob)
    .digest("base64")
    .replace(/=+$/u, "")}`;
  return { keyType, key, fingerprint };
}

function preferredHostKey(keys: readonly HostKey[]): HostKey {
  const priority = [
    "ssh-ed25519",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "ssh-rsa",
  ];
  const rank = (keyType: string) => {
    const index = priority.indexOf(keyType);
    return index < 0 ? priority.length : index;
  };
  return [...keys].sort(
    (left, right) => rank(left.keyType) - rank(right.keyType),
  )[0];
}

function sameHostKey(left: HostKey, right: HostKey): boolean {
  return left.keyType === right.keyType && left.key === right.key;
}

function knownHostsLabel(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

function formatHostPort(host: string, port: number): string {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

function nullDevice(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

function defaultOpenSshCommand(windowsName: string, fallback: string): CommandSpec {
  if (process.platform === "win32") {
    const system = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "OpenSSH",
      windowsName,
    );
    if (existsSync(system)) {
      return { executable: system };
    }
  }
  return { executable: fallback };
}

async function securePrivateDirectory(
  path: string,
  icacls: CommandSpec,
  signal: AbortSignal,
): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(path, 0o700);
    return;
  }

  const username = process.env.USERNAME;
  if (username === undefined || username.trim().length === 0) {
    throw new Error("USERNAME is required to secure a temporary SSH identity");
  }
  const principal =
    process.env.USERDOMAIN === undefined || process.env.USERDOMAIN.length === 0
      ? username
      : `${process.env.USERDOMAIN}\\${username}`;
  await runCommand(
    icacls,
    [path, "/inheritance:r", "/grant:r", `${principal}:(OI)(CI)F`],
    signal,
    8_000,
  );
}

class CommandError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

function runCommand(
  command: CommandSpec,
  args: readonly string[],
  signal: AbortSignal | undefined,
  timeout: number,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command.executable,
      [...(command.prefixArgs ?? []), ...args],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout,
        maxBuffer: 1_048_576,
        signal,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new CommandError(
              error.message,
              typeof error.code === "number" ? error.code : null,
              stdout,
              stderr,
            ),
          );
          return;
        }
        resolve({ code: 0, stdout, stderr });
      },
    );
  });
}

async function waitForSpawn(
  child: ChildProcessWithoutNullStreams,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    child.kill();
    throw normalizedError("cancelled", "SSH channel opening was cancelled");
  }

  await Promise.race([
    once(child, "spawn").then(() => undefined),
    once(child, "error").then(([error]) => Promise.reject(error)),
  ]);
}

async function closeChild(
  child: ChildProcessWithoutNullStreams,
  _signal: AbortSignal,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill();
  await Promise.race([
    once(child, "close").then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await once(child, "close").then(() => undefined);
  }
}

function formatSshDiagnostic(stderr: string): string {
  const diagnostic = stderr.trim().replace(/\s+/gu, " ").slice(-512);
  return diagnostic.length === 0 ? "" : `: ${diagnostic}`;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
