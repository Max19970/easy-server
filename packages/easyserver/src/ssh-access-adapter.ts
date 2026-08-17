import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Duplex, PassThrough } from "node:stream";
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
} from "@easyai101/easyserver-plugin-sdk";
import {
  acquireFilesystemLock,
  FilesystemLockCancelledError,
  FilesystemLockTimeoutError,
} from "./filesystem-lock.js";
import { SshCredentialMaterialManager } from "./ssh-credential-material.js";

interface CommandSpec {
  readonly executable: string;
  readonly prefixArgs?: readonly string[];
}

export interface OpenSshAccessAdapterOptions {
  readonly knownHostsPath?: string;
  readonly sshCommand?: CommandSpec;
  readonly keyscanCommand?: CommandSpec;
  readonly keyscanFallbackCommand?: CommandSpec;
  readonly icaclsCommand?: CommandSpec;
}

interface HostKey {
  readonly keyType: string;
  readonly key: string;
  readonly fingerprint: string;
}

interface PasswordAuth {
  readonly passwordFile: string;
  readonly askpassPreload: string;
}

interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const ASKPASS_PRELOAD = `
const { readFileSync } = require("node:fs");
const passwordFile = process.env.EASYSERVER_SSH_PASSWORD_FILE;
if (passwordFile && process.argv.length === 2) {
  const password = readFileSync(passwordFile, "utf8");
  process.stdout.write(password.endsWith("\\n") ? password : password + "\\n");
  process.exit(0);
}
`;

export class OpenSshAccessAdapter implements AccessAdapter {
  readonly kind = "ssh";
  readonly #knownHostsPath: string;
  readonly #sshCommand: CommandSpec;
  readonly #keyscanCommands: readonly CommandSpec[];
  readonly #icaclsCommand: CommandSpec;
  readonly #credentialMaterial: SshCredentialMaterialManager;

  constructor(options: OpenSshAccessAdapterOptions = {}) {
    this.#knownHostsPath =
      options.knownHostsPath ?? join(homedir(), ".easyserver", "known_hosts");
    this.#sshCommand = options.sshCommand ?? defaultOpenSshCommand("ssh.exe", "ssh");
    this.#keyscanCommands =
      options.keyscanCommand === undefined &&
      options.keyscanFallbackCommand === undefined
        ? defaultKeyscanCommands()
        : [
            options.keyscanCommand ??
              defaultOpenSshCommand("ssh-keyscan.exe", "ssh-keyscan"),
            ...(options.keyscanFallbackCommand === undefined
              ? []
              : [options.keyscanFallbackCommand]),
          ];
    this.#icaclsCommand = options.icaclsCommand ?? { executable: "icacls.exe" };
    this.#credentialMaterial = new SshCredentialMaterialManager({
      root: join(dirname(this.#knownHostsPath), "sessions"),
      secureDirectory: (path, signal) =>
        securePrivateDirectory(path, this.#icaclsCommand, signal),
    });
  }

  initializeCredentialRecovery(): Promise<void> {
    return this.#credentialMaterial.initialize();
  }

  async openTcpForward(
    method: AccessMethod,
    _providerExternalId: string,
    target: TcpForwardTarget,
    context: AccessSetupContext,
  ): Promise<AccessTransportSession> {
    assertSshMethod(method);
    assertSafeSshHost(method.ssh.host);
    await this.#assertHostTrusted(method, context.signal);

    const needsCredentialMaterial =
      method.ssh.privateKeySecretRef !== undefined ||
      method.ssh.passwordCredentialId !== undefined;
    const credentialMaterial = needsCredentialMaterial
      ? await this.#credentialMaterial.create(context.signal)
      : undefined;
    if (credentialMaterial !== undefined) {
      context.registerCleanup(() => credentialMaterial.cleanup());
    }

    const identityFile =
      method.ssh.privateKeySecretRef === undefined
        ? undefined
        : await this.#materializePrivateKey(
            await context.resolveSecret(method.ssh.privateKeySecretRef),
            credentialMaterial!.directory,
          );
    const passwordAuth =
      method.ssh.passwordCredentialId === undefined
        ? undefined
        : await this.#materializePassword(
            await context.resolveCredential(method.ssh.passwordCredentialId),
            credentialMaterial!.directory,
          );

    return new OpenSshTransportSession(
      method,
      target,
      this.#knownHostsPath,
      identityFile,
      passwordAuth,
      this.#sshCommand,
    );
  }

  async enrollHostKey(
    trust: HostTrustRequiredError,
    signal?: AbortSignal,
  ): Promise<void> {
    assertSafeSshHost(trust.host);
    const scanned = await scanHostKeys(
      trust.host,
      trust.port,
      this.#keyscanCommands,
      this.#sshCommand,
      signal,
    );
    const selected = preferredHostKey(scanned);
    if (
      selected.keyType !== trust.keyType ||
      selected.fingerprint !== trust.fingerprint
    ) {
      throw normalizedError(
        "authentication",
        `SSH host key changed before trust confirmation for ${trust.host}:${trust.port}`,
      );
    }

    const label = knownHostsLabel(trust.host, trust.port);
    await withKnownHostsEnrollmentLock(this.#knownHostsPath, signal, async (assertOwned) => {
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

      await assertOwned();
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
      this.#keyscanCommands,
      this.#sshCommand,
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
    directory: string,
  ): Promise<string> {
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

  async #materializePassword(
    secret: string,
    directory: string,
  ): Promise<PasswordAuth> {
    const passwordFile = join(directory, "password");
    const password = await open(passwordFile, "wx", 0o600);
    try {
      await password.writeFile(secret, "utf8");
      await password.sync();
    } finally {
      await password.close();
    }

    const askpassPreload = join(directory, "askpass.cjs");
    const preload = await open(askpassPreload, "wx", 0o600);
    try {
      await preload.writeFile(ASKPASS_PRELOAD, "utf8");
      await preload.sync();
    } finally {
      await preload.close();
    }

    if (process.platform !== "win32") {
      await Promise.all([
        chmod(passwordFile, 0o600),
        chmod(askpassPreload, 0o600),
      ]);
    }
    return { passwordFile, askpassPreload };
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
    private readonly passwordAuth: PasswordAuth | undefined,
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
        ...(this.passwordAuth === undefined
          ? {}
          : { env: passwordEnvironment(this.passwordAuth) }),
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
      throw localOpenSshFailure(error);
    }

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
    });

    let stdinFailure: Error | undefined;
    const input = new PassThrough();
    input.pipe(child.stdin);
    child.stdin.on("error", (error) => {
      stdinFailure = error;
    });
    const stream = Duplex.from({
      readable: child.stdout,
      writable: input,
    });
    stream.on("error", () => undefined);
    let closePromise: Promise<void> | undefined;
    let exitFailure: Error | undefined;
    let closing = false;

    const channel: AccessChannel = {
      stream,
      close: () => {
        if (closePromise === undefined) {
          closing = true;
          stream.destroy();
          closePromise = closeChild(child, context.signal)
            .then(() => {
              if (exitFailure !== undefined) {
                throw exitFailure;
              }
            })
            .finally(() => {
              context.signal.removeEventListener("abort", onAbort);
              this.#channels.delete(channel);
            });
        }
        return closePromise;
      },
    };
    this.#channels.add(channel);

    child.once("exit", () => {
      if (!stream.destroyed && !stream.writableEnded) {
        stream.end();
      }
    });
    child.once("close", (code) => {
      context.signal.removeEventListener("abort", onAbort);
      this.#channels.delete(channel);
      if (!closing && (code !== 0 || stdinFailure !== undefined)) {
        exitFailure = openSshExitFailure(code, stderr);
        if (!stream.destroyed) {
          stream.destroy(exitFailure);
        }
      }
    });
    child.once("error", (error) => stream.destroy(localOpenSshFailure(error)));

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

function assertSafeSshHost(host: string): void {
  if (host.startsWith("-")) {
    throw normalizedError(
      "unsupported-operation",
      "SSH host must not begin with a hyphen.",
    );
  }
}

function passwordEnvironment(auth: PasswordAuth): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SSH_ASKPASS: process.execPath,
    SSH_ASKPASS_REQUIRE: "force",
    EASYSERVER_SSH_PASSWORD_FILE: auth.passwordFile,
    NODE_OPTIONS: `--require ${JSON.stringify(auth.askpassPreload)}`,
  };
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
    method.ssh.passwordCredentialId === undefined
      ? "BatchMode=yes"
      : "BatchMode=no",
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
    method.ssh.passwordCredentialId === undefined
      ? "PasswordAuthentication=no"
      : "PasswordAuthentication=yes",
    "-o",
    "KbdInteractiveAuthentication=no",
    ...(method.ssh.passwordCredentialId === undefined
      ? []
      : [
          "-o",
          "PreferredAuthentications=password",
          "-o",
          "PubkeyAuthentication=no",
          "-o",
          "NumberOfPasswordPrompts=1",
        ]),
    ...(identityFile === undefined
      ? []
      : ["-o", "IdentitiesOnly=yes", "-i", identityFile]),
    method.ssh.host,
  ];
}

async function scanHostKeys(
  host: string,
  port: number,
  commands: readonly CommandSpec[],
  sshCommand: CommandSpec,
  signal?: AbortSignal,
): Promise<readonly HostKey[]> {
  const failures: unknown[] = [];
  for (const command of commands) {
    try {
      const result = await runCommand(
        command,
        ["-T", "5", "-p", String(port), "-t", "ed25519,ecdsa,rsa", host],
        signal,
        8_000,
      );
      const keys = parseKeyscanOutput(result.stdout);
      if (keys.length > 0) {
        return keys;
      }
      failures.push(
        new Error(`SSH key scanner ${command.executable} returned no host keys`),
      );
    } catch (error) {
      if (signal?.aborted) {
        throw normalizedError("cancelled", "SSH host-key scan was cancelled", error);
      }
      if (error instanceof CommandError) {
        const keys = parseKeyscanOutput(error.stdout);
        if (keys.length > 0) {
          return keys;
        }
      }
      failures.push(error);
    }
  }

  try {
    const keys = await scanHostKeysViaOpenSsh(host, port, sshCommand, signal);
    if (keys.length > 0) {
      return keys;
    }
    failures.push(new Error("OpenSSH handshake returned no host key"));
  } catch (error) {
    if (signal?.aborted) {
      throw normalizedError("cancelled", "SSH host-key scan was cancelled", error);
    }
    failures.push(error);
  }

  const cause =
    failures.length === 1
      ? failures[0]
      : new AggregateError(
          failures,
          "No configured SSH key discovery path could read a host key",
        );
  throw normalizedError(
    "provider-unavailable",
    "EasyServer could not obtain the SSH host fingerprint. The SSH endpoint may not be ready, or the local SSH tools could not complete host-key discovery.",
    cause,
  );
}

async function scanHostKeysViaOpenSsh(
  host: string,
  port: number,
  command: CommandSpec,
  signal?: AbortSignal,
): Promise<readonly HostKey[]> {
  const directory = await mkdtemp(join(tmpdir(), "easyserver-ssh-hostkey-"));
  const knownHostsPath = join(directory, "known_hosts");
  try {
    try {
      await runCommand(
        command,
        [
          "-F",
          "none",
          "-T",
          "-N",
          "-p",
          String(port),
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=accept-new",
          "-o",
          `UserKnownHostsFile=${knownHostsPath}`,
          "-o",
          `GlobalKnownHostsFile=${nullDevice()}`,
          "-o",
          "HashKnownHosts=no",
          "-o",
          "CheckHostIP=no",
          "-o",
          "UpdateHostKeys=no",
          "-o",
          "PasswordAuthentication=no",
          "-o",
          "KbdInteractiveAuthentication=no",
          "-o",
          "PubkeyAuthentication=no",
          "-o",
          "HostbasedAuthentication=no",
          "-o",
          "GSSAPIAuthentication=no",
          host,
        ],
        signal,
        8_000,
      );
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      // Authentication is expected to fail: the isolated file is the handshake result.
    }
    return readKnownHostKeys(knownHostsPath, knownHostsLabel(host, port));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
  run: (assertOwned: () => Promise<void>) => Promise<T>,
): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.enroll.lock`;
  let lease: Awaited<ReturnType<typeof acquireFilesystemLock>>;
  try {
    lease = await acquireFilesystemLock(lockPath, {
      timeoutMs: 5_000,
      signal,
    });
  } catch (error) {
    if (error instanceof FilesystemLockCancelledError) {
      throw normalizedError("cancelled", "SSH host-key enrollment was cancelled");
    }
    if (error instanceof FilesystemLockTimeoutError) {
      throw normalizedError(
        "plugin-failure",
        "Timed out waiting for SSH host-key enrollment lock",
      );
    }
    throw error;
  }

  try {
    if (signal?.aborted) {
      throw normalizedError("cancelled", "SSH host-key enrollment was cancelled");
    }
    return await run(() => lease.assertOwned());
  } finally {
    await lease.release();
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

function defaultKeyscanCommands(): readonly CommandSpec[] {
  const preferred = defaultOpenSshCommand("ssh-keyscan.exe", "ssh-keyscan");
  if (process.platform !== "win32" || preferred.executable === "ssh-keyscan") {
    return [preferred];
  }
  return [preferred, { executable: "ssh-keyscan" }];
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
  signal?: AbortSignal,
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

function localOpenSshFailure(cause: unknown): Error {
  return normalizedSshError(
    "plugin-failure",
    "Local OpenSSH client could not be started. Install or enable OpenSSH Client and retry.",
    cause,
  );
}

function openSshExitFailure(code: number | null, stderr: string): Error {
  const diagnostic = stderr.trim().replace(/\s+/gu, " ").slice(-512);
  const cause = new Error(
    `OpenSSH channel exited with code ${code ?? "unknown"}${
      diagnostic.length === 0 ? "" : `: ${diagnostic}`
    }`,
  );
  if (/Permission denied \([^)]*publickey[^)]*\)/iu.test(diagnostic)) {
    return normalizedSshError(
      "authentication",
      "SSH public-key authentication was rejected by the server.",
      cause,
    );
  }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/iu.test(diagnostic)) {
    return normalizedSshError(
      "authentication",
      "SSH host identity no longer matches the trusted host key.",
      cause,
    );
  }
  if (/open failed: administratively prohibited|administratively prohibited: open failed/iu.test(diagnostic)) {
    return normalizedSshError(
      "unsupported-operation",
      "SSH connected, but this server does not permit TCP forwarding.",
      cause,
    );
  }
  if (/open failed: connect failed: Connection refused/iu.test(diagnostic)) {
    return normalizedSshError(
      "provider-unavailable",
      "SSH connected, but the requested service port is not accepting connections yet.",
      cause,
    );
  }
  if (/open failed: connect failed:/iu.test(diagnostic)) {
    return normalizedSshError(
      "provider-unavailable",
      "SSH connected, but the requested service could not be reached from the server.",
      cause,
    );
  }
  if (/Permission denied/iu.test(diagnostic)) {
    return normalizedSshError(
      "authentication",
      "SSH authentication was rejected by the server.",
      cause,
    );
  }
  if (/Connection closed by [^\s]+ port \d+/iu.test(diagnostic)) {
    return normalizedSshError(
      "provider-unavailable",
      "The SSH route closed before TCP forwarding was established.",
      cause,
    );
  }
  if (
    /Connection refused|Connection timed out|Operation timed out|No route to host|Connection reset by peer|kex_exchange_identification/iu.test(
      diagnostic,
    )
  ) {
    return normalizedSshError(
      "provider-unavailable",
      "SSH on the server is not ready or reachable yet.",
      cause,
    );
  }
  return normalizedSshError(
    "plugin-failure",
    "OpenSSH connection failed unexpectedly.",
    cause,
  );
}

function normalizedSshError(
  code: Parameters<typeof normalizedError>[0],
  message: string,
  cause: unknown,
): Error {
  return Object.assign(new Error(message), normalizedError(code, message, cause));
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
