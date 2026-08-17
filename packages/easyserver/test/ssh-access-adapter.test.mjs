import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  hostTrustRequiredError,
  isHostTrustRequiredError,
  parseAccessMethods,
} from "@easyai101/easyserver-plugin-sdk";
import { connectionFailureDetails } from "../dist/connection-failure.js";
import { OpenSshAccessAdapter } from "../dist/ssh-access-adapter.js";

const fakeKeyscan = fileURLToPath(
  new URL("./fixtures/fake-ssh-keyscan.mjs", import.meta.url),
);
const fakeSsh = fileURLToPath(
  new URL("./fixtures/fake-ssh.mjs", import.meta.url),
);
const fakeSshExit = fileURLToPath(
  new URL("./fixtures/fake-ssh-exit.mjs", import.meta.url),
);
const fakeSshHostKeyHandshake = fileURLToPath(
  new URL("./fixtures/fake-ssh-hostkey-handshake.mjs", import.meta.url),
);
const noopCommand = fileURLToPath(
  new URL("./fixtures/noop-command.mjs", import.meta.url),
);
const sshCredentialOwner = fileURLToPath(
  new URL("./fixtures/ssh-credential-owner.mjs", import.meta.url),
);
const context = { signal: new AbortController().signal };

async function withTempDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "easyserver-ssh-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function typedKey(keyType, value) {
  return {
    keyType,
    key: Buffer.from(value).toString("base64"),
  };
}

function key(value) {
  return typedKey("ssh-ed25519", value);
}

function keyFingerprint(spec) {
  return `SHA256:${createHash("sha256")
    .update(Buffer.from(spec.key, "base64"))
    .digest("base64")
    .replace(/=+$/u, "")}`;
}

function sshMethod(privateKeySecretRef) {
  return parseAccessMethods([
    {
      id: "direct-ssh",
      kind: "ssh",
      mode: "tcp-forward",
      ssh: {
        host: "ssh.example.test",
        port: 2222,
        username: "ubuntu",
        ...(privateKeySecretRef === undefined ? {} : { privateKeySecretRef }),
      },
    },
  ])[0];
}

function passwordSshMethod() {
  return parseAccessMethods([
    {
      id: "password-ssh",
      kind: "ssh",
      mode: "tcp-forward",
      credentialSources: [
        { kind: "provider-deferred", id: "ssh-password" },
      ],
      ssh: {
        host: "ssh.example.test",
        port: 2222,
        username: "ubuntu",
        passwordCredentialId: "ssh-password",
      },
    },
  ])[0];
}

function adapter(directory, keySpecPath, recordPath, sshFixture = fakeSsh) {
  return new OpenSshAccessAdapter({
    knownHostsPath: join(directory, "known_hosts"),
    keyscanCommand: {
      executable: process.execPath,
      prefixArgs: [fakeKeyscan, keySpecPath],
    },
    sshCommand: {
      executable: process.execPath,
      prefixArgs: [sshFixture, recordPath],
    },
    icaclsCommand: {
      executable: process.execPath,
      prefixArgs: [noopCommand],
    },
  });
}

function setupContext({
  resolveSecret = async () => assert.fail("secret not expected"),
  resolveCredential = async () => assert.fail("credential not expected"),
} = {}) {
  const cleanups = [];
  return {
    context: {
      signal: context.signal,
      registerCleanup(cleanup) {
        cleanups.push(cleanup);
      },
      resolveSecret,
      resolveCredential,
    },
    async cleanup() {
      for (const cleanup of cleanups.reverse()) {
        await cleanup();
      }
    },
  };
}

async function waitForFile(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForJsonFile(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for valid JSON in ${path}`);
}

async function directoryEntriesOrEmpty(path) {
  try {
    return await readdir(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function spawnCredentialOwner(directory, keySpecPath, readyPath, mode) {
  return spawn(
    process.execPath,
    [sshCredentialOwner, directory, keySpecPath, readyPath, mode],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
}

async function childResult(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code, signal] = await once(child, "exit");
  return { code, signal, stdout, stderr };
}

async function captureTrustError(run) {
  try {
    await run();
  } catch (error) {
    assert.equal(isHostTrustRequiredError(error), true);
    return error;
  }
  assert.fail("expected host-trust-required");
}

test("OpenSSH adapter rejects option-like SSH hosts before launching local tools", async () => {
  await withTempDirectory(async (directory) => {
    const access = new OpenSshAccessAdapter({
      knownHostsPath: join(directory, "known_hosts"),
      keyscanCommand: { executable: join(directory, "must-not-run-keyscan") },
      sshCommand: { executable: join(directory, "must-not-run-ssh") },
      icaclsCommand: {
        executable: process.execPath,
        prefixArgs: [noopCommand],
      },
    });
    const safe = sshMethod();
    const unsafe = {
      ...safe,
      ssh: { ...safe.ssh, host: "-oProxyCommand=malicious" },
    };
    const setup = setupContext();

    await assert.rejects(
      access.openTcpForward(
        unsafe,
        "remote-1",
        { host: "service.internal", port: 443 },
        setup.context,
      ),
      (error) =>
        error?.code === "unsupported-operation" &&
        error.message === "SSH host must not begin with a hyphen.",
    );
    await assert.rejects(
      access.enrollHostKey(
        hostTrustRequiredError(
          "-oProxyCommand=malicious",
          22,
          "ssh-ed25519",
          "SHA256:fixture",
        ),
        context.signal,
      ),
      (error) =>
        error?.code === "unsupported-operation" &&
        error.message === "SSH host must not begin with a hyphen.",
    );
  });
});

test("SSH host trust falls back when the preferred key scanner is incompatible", async () => {
  await withTempDirectory(async (directory) => {
    const keySpecPath = join(directory, "host-key.json");
    const recordPath = join(directory, "ssh-args.json");
    await writeFile(keySpecPath, JSON.stringify(key("fallback-host-key")), "utf8");
    const access = new OpenSshAccessAdapter({
      knownHostsPath: join(directory, "known_hosts"),
      keyscanCommand: {
        executable: process.execPath,
        prefixArgs: [
          "-e",
          "process.stderr.write('choose_kex: unsupported KEX method\\n'); process.exit(1);",
        ],
      },
      keyscanFallbackCommand: {
        executable: process.execPath,
        prefixArgs: [fakeKeyscan, keySpecPath],
      },
      sshCommand: {
        executable: process.execPath,
        prefixArgs: [fakeSsh, recordPath],
      },
      icaclsCommand: {
        executable: process.execPath,
        prefixArgs: [noopCommand],
      },
    });
    const method = sshMethod();
    const setup = setupContext();

    const trust = await captureTrustError(() =>
      access.openTcpForward(
        method,
        "remote-1",
        { host: "service.internal", port: 443 },
        setup.context,
      ),
    );
    assert.match(trust.fingerprint, /^SHA256:/);

    await access.enrollHostKey(trust, context.signal);
    const transport = await access.openTcpForward(
      method,
      "remote-1",
      { host: "service.internal", port: 443 },
      setup.context,
    );
    await transport.close();
    await setup.cleanup();
  });
});

test("missing local SSH discovery tools report that no fingerprint could be obtained", async () => {
  await withTempDirectory(async (directory) => {
    const access = new OpenSshAccessAdapter({
      knownHostsPath: join(directory, "known_hosts"),
      keyscanCommand: {
        executable: join(directory, "missing-ssh-keyscan"),
      },
      sshCommand: {
        executable: join(directory, "missing-ssh"),
      },
      icaclsCommand: {
        executable: process.execPath,
        prefixArgs: [noopCommand],
      },
    });
    const setup = setupContext();

    await assert.rejects(
      access.openTcpForward(
        sshMethod(),
        "remote-1",
        { host: "service.internal", port: 443 },
        setup.context,
      ),
      (error) =>
        error?.code === "provider-unavailable" &&
        connectionFailureDetails(error)?.cause === "ssh-fingerprint-unavailable" &&
        error.message ===
          "EasyServer could not obtain the SSH host fingerprint. The SSH endpoint may not be ready, or the local SSH tools could not complete host-key discovery.",
    );
  });
});

test("OpenSSH handshake can recover first-use trust evidence when key scanners fail", async () => {
  await withTempDirectory(async (directory) => {
    const keySpecPath = join(directory, "host-key.json");
    const firstKey = key("handshake-host-key");
    await writeFile(keySpecPath, JSON.stringify(firstKey), "utf8");
    const access = new OpenSshAccessAdapter({
      knownHostsPath: join(directory, "known_hosts"),
      keyscanCommand: {
        executable: join(directory, "missing-ssh-keyscan"),
      },
      sshCommand: {
        executable: process.execPath,
        prefixArgs: [fakeSshHostKeyHandshake, keySpecPath],
      },
      icaclsCommand: {
        executable: process.execPath,
        prefixArgs: [noopCommand],
      },
    });
    const setup = setupContext();

    const trust = await captureTrustError(() =>
      access.openTcpForward(
        sshMethod(),
        "remote-1",
        { host: "service.internal", port: 443 },
        setup.context,
      ),
    );
    assert.equal(trust.host, "ssh.example.test");
    assert.equal(trust.port, 2222);
    assert.equal(trust.keyType, firstKey.keyType);
    assert.match(trust.fingerprint, /^SHA256:/);

    await access.enrollHostKey(trust, context.signal);
    const knownHosts = await readFile(join(directory, "known_hosts"), "utf8");
    assert.equal(
      knownHosts,
      `[ssh.example.test]:2222 ${firstKey.keyType} ${firstKey.key}\n`,
    );
    await setup.cleanup();
  });
});

test("fallback host-key enrollment revalidates the confirmed fingerprint", async () => {
  await withTempDirectory(async (directory) => {
    const keySpecPath = join(directory, "host-key.json");
    const recordPath = join(directory, "ssh-args.json");
    const firstKey = key("fallback-host-key-one");
    await writeFile(keySpecPath, JSON.stringify(firstKey), "utf8");
    const access = new OpenSshAccessAdapter({
      knownHostsPath: join(directory, "known_hosts"),
      keyscanCommand: {
        executable: process.execPath,
        prefixArgs: [
          "-e",
          "process.stderr.write('choose_kex: unsupported KEX method\\n'); process.exit(1);",
        ],
      },
      keyscanFallbackCommand: {
        executable: process.execPath,
        prefixArgs: [fakeKeyscan, keySpecPath],
      },
      sshCommand: {
        executable: process.execPath,
        prefixArgs: [fakeSsh, recordPath],
      },
      icaclsCommand: {
        executable: process.execPath,
        prefixArgs: [noopCommand],
      },
    });
    const setup = setupContext();
    const trust = await captureTrustError(() =>
      access.openTcpForward(
        sshMethod(),
        "remote-1",
        { host: "service.internal", port: 443 },
        setup.context,
      ),
    );

    await writeFile(
      keySpecPath,
      JSON.stringify(key("fallback-host-key-two")),
      "utf8",
    );
    await assert.rejects(
      () => access.enrollHostKey(trust, context.signal),
      (error) =>
        error?.code === "authentication" &&
        /changed before trust confirmation/.test(error.message),
    );
    await setup.cleanup();
  });
});

test("unknown SSH host requires explicit fingerprint enrollment and changed keys fail closed", async () => {
  await withTempDirectory(async (directory) => {
    const keySpecPath = join(directory, "host-key.json");
    const recordPath = join(directory, "ssh-args.json");
    const firstKey = key("host-key-one");
    await writeFile(keySpecPath, JSON.stringify(firstKey), "utf8");
    const access = adapter(directory, keySpecPath, recordPath);
    const method = sshMethod();
    const setup = setupContext();

    const trust = await captureTrustError(() =>
      access.openTcpForward(
        method,
        "remote-1",
        { host: "service.internal", port: 443 },
        setup.context,
      ),
    );
    assert.equal(trust.host, "ssh.example.test");
    assert.equal(trust.port, 2222);
    assert.equal(trust.keyType, "ssh-ed25519");
    assert.match(trust.fingerprint, /^SHA256:/);

    await access.enrollHostKey(trust, context.signal);
    const knownHosts = await readFile(join(directory, "known_hosts"), "utf8");
    assert.match(knownHosts, /^\[ssh\.example\.test\]:2222 ssh-ed25519 /);

    const transport = await access.openTcpForward(
      method,
      "remote-1",
      { host: "service.internal", port: 443 },
      setup.context,
    );
    const channel = await transport.openChannel(context);
    const received = new Promise((resolve) => channel.stream.once("data", resolve));
    channel.stream.write("hello");
    assert.equal((await received).toString(), "hello");

    const args = JSON.parse(await waitForFile(recordPath));
    assert.deepEqual(args.slice(0, 2), ["-F", "none"]);
    assert.ok(args.includes("StrictHostKeyChecking=yes"));
    assert.ok(args.includes(`UserKnownHostsFile=${join(directory, "known_hosts")}`));
    assert.ok(args.includes(`GlobalKnownHostsFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`));
    assert.deepEqual(args.slice(args.indexOf("-W"), args.indexOf("-W") + 2), [
      "-W",
      "service.internal:443",
    ]);
    assert.deepEqual(args.slice(args.indexOf("-p"), args.indexOf("-p") + 2), [
      "-p",
      "2222",
    ]);
    assert.deepEqual(args.slice(args.indexOf("-l"), args.indexOf("-l") + 2), [
      "-l",
      "ubuntu",
    ]);

    await channel.close();
    await transport.close();
    await setup.cleanup();

    await writeFile(keySpecPath, JSON.stringify(key("host-key-two")), "utf8");
    await assert.rejects(
      access.openTcpForward(
        method,
        "remote-1",
        { host: "service.internal", port: 443 },
        setupContext().context,
      ),
      (error) => error?.code === "authentication" && /mismatch/.test(error.message),
    );
  });
});

test("host-key approval accepts only the reported preferred key and is idempotent", async () => {
  await withTempDirectory(async (directory) => {
    const keySpecPath = join(directory, "host-keys.json");
    const recordPath = join(directory, "ssh-args.json");
    const alternate = typedKey("ssh-rsa", "alternate-rsa-host-key");
    const preferred = key("preferred-ed25519-host-key");
    await writeFile(
      keySpecPath,
      JSON.stringify([alternate, preferred]),
      "utf8",
    );
    const access = adapter(directory, keySpecPath, recordPath);
    const setup = setupContext();

    const observed = await captureTrustError(() =>
      access.openTcpForward(
        sshMethod(),
        "remote-1",
        { host: "service.internal", port: 443 },
        setup.context,
      ),
    );
    assert.equal(observed.keyType, preferred.keyType);
    assert.equal(observed.fingerprint, keyFingerprint(preferred));

    const fabricatedAlternate = hostTrustRequiredError(
      observed.host,
      observed.port,
      alternate.keyType,
      keyFingerprint(alternate),
    );
    await assert.rejects(
      () => access.enrollHostKey(fabricatedAlternate, context.signal),
      (error) =>
        error?.code === "authentication" &&
        /changed before trust confirmation/.test(error.message),
    );
    await assert.rejects(
      () => readFile(join(directory, "known_hosts"), "utf8"),
      (error) => error?.code === "ENOENT",
    );

    await access.enrollHostKey(observed, context.signal);
    await access.enrollHostKey(observed, context.signal);
    const knownHosts = await readFile(join(directory, "known_hosts"), "utf8");
    assert.deepEqual(
      knownHosts.trim().split(/\r?\n/u),
      [`[ssh.example.test]:2222 ${preferred.keyType} ${preferred.key}`],
    );
    await setup.cleanup();
  });
});

test("concurrent SSH host-key enrollments never trust conflicting keys", async () => {
  await withTempDirectory(async (directory) => {
    const firstKeySpecPath = join(directory, "host-key-one.json");
    const secondKeySpecPath = join(directory, "host-key-two.json");
    const firstKey = key("host-key-one");
    const secondKey = key("host-key-two");
    await writeFile(firstKeySpecPath, JSON.stringify(firstKey), "utf8");
    await writeFile(secondKeySpecPath, JSON.stringify(secondKey), "utf8");

    const firstAccess = adapter(
      directory,
      firstKeySpecPath,
      join(directory, "ssh-args-one.json"),
    );
    const secondAccess = adapter(
      directory,
      secondKeySpecPath,
      join(directory, "ssh-args-two.json"),
    );
    const method = sshMethod();
    const target = { host: "service.internal", port: 443 };
    const firstTrust = await captureTrustError(() =>
      firstAccess.openTcpForward(
        method,
        "remote-1",
        target,
        setupContext().context,
      ),
    );
    const secondTrust = await captureTrustError(() =>
      secondAccess.openTcpForward(
        method,
        "remote-1",
        target,
        setupContext().context,
      ),
    );

    const enrollments = Array.from({ length: 16 }, (_, index) =>
      index % 2 === 0
        ? firstAccess.enrollHostKey(firstTrust, context.signal)
        : secondAccess.enrollHostKey(secondTrust, context.signal),
    );
    const results = await Promise.allSettled(enrollments);
    const knownHosts = await readFile(join(directory, "known_hosts"), "utf8");
    const enrolledKeys = knownHosts
      .trim()
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("[ssh.example.test]:2222 "));

    assert.equal(enrolledKeys.length, 1);
    const winner = enrolledKeys[0].includes(firstKey.key) ? firstKey : secondKey;
    const loser = winner === firstKey ? secondKey : firstKey;
    assert.equal(enrolledKeys[0], `[ssh.example.test]:2222 ${winner.keyType} ${winner.key}`);
    assert.ok(results.some((result) => result.status === "fulfilled"));
    assert.ok(
      results.some(
        (result) =>
          result.status === "rejected" &&
          result.reason?.code === "authentication" &&
          /mismatch/.test(result.reason.message),
      ),
    );
    assert.equal(knownHosts.includes(loser.key), false);
  });
});

test("SSH host-key enrollment recovers from a crash-stale lock generation", async () => {
  await withTempDirectory(async (directory) => {
    const keySpecPath = join(directory, "host-key.json");
    const recordPath = join(directory, "ssh-args.json");
    await writeFile(keySpecPath, JSON.stringify(key("host-key-one")), "utf8");
    const access = adapter(directory, keySpecPath, recordPath);
    const method = sshMethod();
    const target = { host: "service.internal", port: 443 };
    const trust = await captureTrustError(() =>
      access.openTcpForward(
        method,
        "remote-1",
        target,
        setupContext().context,
      ),
    );

    const lockPath = join(directory, "known_hosts.enroll.lock");
    await mkdir(lockPath);
    const staleOwner = join(lockPath, "crashed-generation.owner");
    await writeFile(staleOwner, `${process.pid}\n`, "utf8");
    const stale = new Date(Date.now() - 60_000);
    await utimes(staleOwner, stale, stale);

    await access.enrollHostKey(trust, context.signal);
    const knownHosts = await readFile(join(directory, "known_hosts"), "utf8");
    assert.match(knownHosts, /\[ssh\.example\.test\]:2222 ssh-ed25519 /u);
  });
});

test("SSH channel abort during spawn rejects and cleans up", async () => {
  await withTempDirectory(async (directory) => {
    const keySpecPath = join(directory, "host-key.json");
    const recordPath = join(directory, "ssh-args.json");
    await writeFile(keySpecPath, JSON.stringify(key("host-key-one")), "utf8");
    const access = adapter(directory, keySpecPath, recordPath);
    const method = sshMethod();
    const setup = setupContext();
    const trust = await captureTrustError(() =>
      access.openTcpForward(
        method,
        "remote-1",
        { host: "service.internal", port: 443 },
        setup.context,
      ),
    );
    await access.enrollHostKey(trust, context.signal);
    const transport = await access.openTcpForward(
      method,
      "remote-1",
      { host: "service.internal", port: 443 },
      setup.context,
    );
    const controller = new AbortController();
    const opening = transport.openChannel({ signal: controller.signal });
    controller.abort();

    try {
      await assert.rejects(
        opening,
        (error) => error?.code === "cancelled",
      );
    } finally {
      await transport.close();
      await setup.cleanup();
    }
  });
});

test("abrupt OpenSSH child exit fails the channel without exposing raw remote output", async () => {
  await withTempDirectory(async (directory) => {
    const keySpecPath = join(directory, "host-key.json");
    const recordPath = join(directory, "ssh-args.json");
    await writeFile(keySpecPath, JSON.stringify(key("host-key-one")), "utf8");
    const access = adapter(directory, keySpecPath, recordPath, fakeSshExit);
    const method = sshMethod();
    const setup = setupContext();
    const trust = await captureTrustError(() =>
      access.openTcpForward(
        method,
        "remote-1",
        { host: "service.internal", port: 443 },
        setup.context,
      ),
    );
    await access.enrollHostKey(trust, context.signal);
    const transport = await access.openTcpForward(
      method,
      "remote-1",
      { host: "service.internal", port: 443 },
      setup.context,
    );
    const channel = await transport.openChannel(context);

    try {
      const streamError = once(channel.stream, "error");
      channel.stream.write(Buffer.alloc(256 * 1024));
      const [error] = await streamError;
      assert.equal(error.code, "plugin-failure");
      assert.equal(connectionFailureDetails(error)?.cause, "unexpected-ssh-transport");
      assert.equal(error.message, "OpenSSH connection failed unexpectedly.");
      assert.doesNotMatch(error.message, /fixture abrupt SSH exit/);
      await assert.rejects(
        channel.close(),
        (closeError) =>
          closeError?.code === "plugin-failure" &&
          closeError.message === "OpenSSH connection failed unexpectedly.",
      );
    } finally {
      await transport.close();
      await setup.cleanup();
    }
  });
});

test("OpenSSH public-key rejection is a safe authentication failure", async () => {
  await withTempDirectory(async (directory) => {
    const keySpecPath = join(directory, "host-key.json");
    await writeFile(keySpecPath, JSON.stringify(key("host-key-one")), "utf8");
    const access = new OpenSshAccessAdapter({
      knownHostsPath: join(directory, "known_hosts"),
      keyscanCommand: {
        executable: process.execPath,
        prefixArgs: [fakeKeyscan, keySpecPath],
      },
      sshCommand: {
        executable: process.execPath,
        prefixArgs: [
          "-e",
          "process.stderr.write('root@host: Permission denied (publickey).\\n'); setTimeout(() => process.exit(255), 25);",
          "--",
        ],
      },
      icaclsCommand: {
        executable: process.execPath,
        prefixArgs: [noopCommand],
      },
    });
    const method = sshMethod();
    const setup = setupContext();
    const trust = await captureTrustError(() =>
      access.openTcpForward(
        method,
        "remote-1",
        { host: "service.internal", port: 443 },
        setup.context,
      ),
    );
    await access.enrollHostKey(trust, context.signal);
    const transport = await access.openTcpForward(
      method,
      "remote-1",
      { host: "service.internal", port: 443 },
      setup.context,
    );
    const channel = await transport.openChannel(context);

    try {
      const [error] = await once(channel.stream, "error");
      assert.equal(error.code, "authentication");
      assert.equal(connectionFailureDetails(error)?.cause, "ssh-public-key-rejected");
      assert.equal(
        error.message,
        "SSH public-key authentication was rejected by the server.",
      );
      assert.doesNotMatch(error.message, /root@host|Permission denied/);
      await assert.rejects(
        channel.close(),
        (closeError) =>
          closeError?.code === "authentication" &&
          closeError.message ===
            "SSH public-key authentication was rejected by the server.",
      );
    } finally {
      await transport.close();
      await setup.cleanup();
    }
  });
});

test("OpenSSH password rejection is a safe authentication failure", async () => {
  await withTempDirectory(async (directory) => {
    const keySpecPath = join(directory, "host-key.json");
    await writeFile(keySpecPath, JSON.stringify(key("host-key-one")), "utf8");
    const access = new OpenSshAccessAdapter({
      knownHostsPath: join(directory, "known_hosts"),
      keyscanCommand: {
        executable: process.execPath,
        prefixArgs: [fakeKeyscan, keySpecPath],
      },
      sshCommand: {
        executable: process.execPath,
        prefixArgs: [
          "-e",
          "process.stderr.write('Permission denied (password).\\n'); setTimeout(() => process.exit(255), 25);",
          "--",
        ],
      },
      icaclsCommand: {
        executable: process.execPath,
        prefixArgs: [noopCommand],
      },
    });
    const method = passwordSshMethod();
    const setup = setupContext({
      async resolveCredential(id) {
        assert.equal(id, "ssh-password");
        return "fixture-server-password";
      },
    });
    const trust = await captureTrustError(() =>
      access.openTcpForward(
        method,
        "remote-1",
        { host: "service.internal", port: 443 },
        setup.context,
      ),
    );
    await access.enrollHostKey(trust, context.signal);
    const transport = await access.openTcpForward(
      method,
      "remote-1",
      { host: "service.internal", port: 443 },
      setup.context,
    );
    const channel = await transport.openChannel(context);

    try {
      const [error] = await once(channel.stream, "error");
      assert.equal(error.code, "authentication");
      assert.equal(error.message, "SSH authentication was rejected by the server.");
      assert.doesNotMatch(error.message, /Permission denied|password/i);
      await assert.rejects(
        channel.close(),
        (closeError) =>
          closeError?.code === "authentication" &&
          closeError.message === "SSH authentication was rejected by the server.",
      );
    } finally {
      await transport.close();
      await setup.cleanup();
    }
  });
});

test("OpenSSH remote service refusal is distinct from SSH readiness failure", async () => {
  await withTempDirectory(async (directory) => {
    const keySpecPath = join(directory, "host-key.json");
    await writeFile(keySpecPath, JSON.stringify(key("host-key-one")), "utf8");
    const access = new OpenSshAccessAdapter({
      knownHostsPath: join(directory, "known_hosts"),
      keyscanCommand: {
        executable: process.execPath,
        prefixArgs: [fakeKeyscan, keySpecPath],
      },
      sshCommand: {
        executable: process.execPath,
        prefixArgs: [
          "-e",
          "process.stderr.write('channel 0: open failed: connect failed: Connection refused\\nstdio forwarding failed\\n'); setTimeout(() => process.exit(255), 25);",
          "--",
        ],
      },
      icaclsCommand: {
        executable: process.execPath,
        prefixArgs: [noopCommand],
      },
    });
    const method = sshMethod();
    const setup = setupContext();
    const trust = await captureTrustError(() =>
      access.openTcpForward(
        method,
        "remote-1",
        { host: "service.internal", port: 8188 },
        setup.context,
      ),
    );
    await access.enrollHostKey(trust, context.signal);
    const transport = await access.openTcpForward(
      method,
      "remote-1",
      { host: "service.internal", port: 8188 },
      setup.context,
    );
    const channel = await transport.openChannel(context);

    try {
      const [error] = await once(channel.stream, "error");
      assert.equal(error.code, "provider-unavailable");
      assert.equal(connectionFailureDetails(error)?.cause, "remote-service-unavailable");
      assert.equal(
        error.message,
        "SSH connected, but the requested service port is not accepting connections yet.",
      );
      assert.doesNotMatch(error.message, /channel 0|stdio forwarding|Connection refused/);
      await assert.rejects(
        channel.close(),
        (closeError) =>
          closeError?.code === "provider-unavailable" &&
          closeError.message ===
            "SSH connected, but the requested service port is not accepting connections yet.",
      );
    } finally {
      await transport.close();
      await setup.cleanup();
    }
  });
});

test("OpenSSH forwarding policy rejection is distinct from SSH login failure", async () => {
  await withTempDirectory(async (directory) => {
    const keySpecPath = join(directory, "host-key.json");
    await writeFile(keySpecPath, JSON.stringify(key("host-key-one")), "utf8");
    const access = new OpenSshAccessAdapter({
      knownHostsPath: join(directory, "known_hosts"),
      keyscanCommand: {
        executable: process.execPath,
        prefixArgs: [fakeKeyscan, keySpecPath],
      },
      sshCommand: {
        executable: process.execPath,
        prefixArgs: [
          "-e",
          "process.stderr.write('channel 0: open failed: administratively prohibited: open failed\\nstdio forwarding failed\\n'); setTimeout(() => process.exit(255), 25);",
          "--",
        ],
      },
      icaclsCommand: {
        executable: process.execPath,
        prefixArgs: [noopCommand],
      },
    });
    const setup = setupContext();
    const trust = await captureTrustError(() =>
      access.openTcpForward(
        sshMethod(),
        "remote-1",
        { host: "service.internal", port: 8188 },
        setup.context,
      ),
    );
    await access.enrollHostKey(trust, context.signal);
    const transport = await access.openTcpForward(
      sshMethod(),
      "remote-1",
      { host: "service.internal", port: 8188 },
      setup.context,
    );
    const channel = await transport.openChannel(context);

    try {
      const [error] = await once(channel.stream, "error");
      assert.equal(error.code, "unsupported-operation");
      assert.equal(connectionFailureDetails(error)?.cause, "tcp-forwarding-forbidden");
      assert.equal(
        error.message,
        "SSH connected, but this server does not permit TCP forwarding.",
      );
      assert.doesNotMatch(error.message, /administratively prohibited|channel 0|stdio/);
    } finally {
      await channel.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      await setup.cleanup();
    }
  });
});

test("OpenSSH remote target timeout is distinct from SSH readiness failure", async () => {
  await withTempDirectory(async (directory) => {
    const keySpecPath = join(directory, "host-key.json");
    await writeFile(keySpecPath, JSON.stringify(key("host-key-one")), "utf8");
    const access = new OpenSshAccessAdapter({
      knownHostsPath: join(directory, "known_hosts"),
      keyscanCommand: {
        executable: process.execPath,
        prefixArgs: [fakeKeyscan, keySpecPath],
      },
      sshCommand: {
        executable: process.execPath,
        prefixArgs: [
          "-e",
          "process.stderr.write('channel 0: open failed: connect failed: Connection timed out\\nstdio forwarding failed\\n'); setTimeout(() => process.exit(255), 25);",
          "--",
        ],
      },
      icaclsCommand: {
        executable: process.execPath,
        prefixArgs: [noopCommand],
      },
    });
    const setup = setupContext();
    const trust = await captureTrustError(() =>
      access.openTcpForward(
        sshMethod(),
        "remote-1",
        { host: "service.internal", port: 8188 },
        setup.context,
      ),
    );
    await access.enrollHostKey(trust, context.signal);
    const transport = await access.openTcpForward(
      sshMethod(),
      "remote-1",
      { host: "service.internal", port: 8188 },
      setup.context,
    );
    const channel = await transport.openChannel(context);

    try {
      const [error] = await once(channel.stream, "error");
      assert.equal(error.code, "provider-unavailable");
      assert.equal(connectionFailureDetails(error)?.cause, "remote-service-unavailable");
      assert.equal(
        error.message,
        "SSH connected, but the requested service could not be reached from the server.",
      );
      assert.doesNotMatch(error.message, /Connection timed out|channel 0|stdio/);
    } finally {
      await channel.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      await setup.cleanup();
    }
  });
});

test("deferred SSH password is resolved only after trust and passed through askpass", async () => {
  await withTempDirectory(async (directory) => {
    const keySpecPath = join(directory, "host-key.json");
    const recordPath = join(directory, "ssh-args.json");
    await writeFile(keySpecPath, JSON.stringify(key("host-key-one")), "utf8");
    const access = adapter(
      join(directory, "session path with spaces"),
      keySpecPath,
      recordPath,
    );
    const method = passwordSshMethod();
    let credentialReads = 0;
    const setup = setupContext({
      async resolveCredential(id) {
        credentialReads += 1;
        assert.equal(id, "ssh-password");
        return "fixture-server-password";
      },
    });

    const trust = await captureTrustError(() =>
      access.openTcpForward(
        method,
        "remote-1",
        { host: "127.0.0.1", port: 8000 },
        setup.context,
      ),
    );
    assert.equal(credentialReads, 0);
    await access.enrollHostKey(trust, context.signal);

    const transport = await access.openTcpForward(
      method,
      "remote-1",
      { host: "127.0.0.1", port: 8000 },
      setup.context,
    );
    assert.equal(credentialReads, 1);
    const channel = await transport.openChannel(context);

    const args = JSON.parse(await waitForFile(recordPath));
    assert.ok(args.includes("BatchMode=no"));
    assert.ok(args.includes("PasswordAuthentication=yes"));
    assert.ok(args.includes("PreferredAuthentications=password"));
    assert.equal(args.some((arg) => arg.includes("fixture-server-password")), false);

    const auth = JSON.parse(await waitForFile(`${recordPath}.auth.json`));
    assert.equal(auth.askpassRequire, "force");
    assert.equal(auth.password, "fixture-server-password");

    await channel.close();
    await transport.close();
    await setup.cleanup();
    await assert.rejects(readFile(auth.passwordFile, "utf8"), (error) => error?.code === "ENOENT");
  });
});

test("private SSH identity is resolved only after trust and cleaned with setup scope", async () => {
  await withTempDirectory(async (directory) => {
    const keySpecPath = join(directory, "host-key.json");
    const recordPath = join(directory, "ssh-args.json");
    await writeFile(keySpecPath, JSON.stringify(key("host-key-one")), "utf8");
    const access = adapter(directory, keySpecPath, recordPath);
    const plainMethod = sshMethod();
    const trust = await captureTrustError(() =>
      access.openTcpForward(
        plainMethod,
        "remote-1",
        { host: "127.0.0.1", port: 8000 },
        setupContext().context,
      ),
    );
    await access.enrollHostKey(trust, context.signal);

    const secretRef = "secret:550e8400-e29b-41d4-a716-446655440000";
    const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-private-material\n-----END OPENSSH PRIVATE KEY-----";
    let resolvedRef;
    const setup = setupContext({
      async resolveSecret(ref) {
        resolvedRef = ref;
        return privateKey;
      },
    });
    const transport = await access.openTcpForward(
      sshMethod(secretRef),
      "remote-1",
      { host: "127.0.0.1", port: 8000 },
      setup.context,
    );
    const channel = await transport.openChannel(context);
    assert.equal(resolvedRef, secretRef);

    const args = JSON.parse(await waitForFile(recordPath));
    const identityIndex = args.indexOf("-i");
    assert.notEqual(identityIndex, -1);
    const identityPath = args[identityIndex + 1];
    assert.equal((await readFile(identityPath, "utf8")).trimEnd(), privateKey);
    assert.equal(JSON.stringify(args).includes("fixture-private-material"), false);

    await channel.close();
    await transport.close();
    await setup.cleanup();
    await assert.rejects(readFile(identityPath, "utf8"), (error) => error?.code === "ENOENT");
  });
});

test("crash-owned SSH credential material is scavenged after the exact owner process exits", async () => {
  if (process.platform !== "win32" && process.platform !== "linux") {
    return;
  }
  await withTempDirectory(async (directory) => {
    const keySpecPath = join(directory, "host-key.json");
    const readyPath = join(directory, "owner-ready.json");
    const hostKey = key("crash-owner-host-key");
    await writeFile(keySpecPath, JSON.stringify(hostKey), "utf8");
    await writeFile(
      join(directory, "known_hosts"),
      `[ssh.example.test]:2222 ${hostKey.keyType} ${hostKey.key}\n`,
      "utf8",
    );

    const child = spawnCredentialOwner(directory, keySpecPath, readyPath, "exit");
    const result = await childResult(child);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const ready = await waitForJsonFile(readyPath);
    assert.equal(ready.sessions.length, 1);
    const credentialDirectory = join(directory, "sessions", ready.sessions[0]);
    assert.match(
      await readFile(join(credentialDirectory, "identity"), "utf8"),
      /crash-fixture-private-material/,
    );

    const recovery = adapter(
      directory,
      keySpecPath,
      join(directory, "recovery-ssh-args.json"),
    );
    await recovery.initializeCredentialRecovery();
    assert.deepEqual(await directoryEntriesOrEmpty(join(directory, "sessions")), []);
  });
});

test("credential scavenging never deletes material owned by another live process", async () => {
  if (process.platform !== "win32" && process.platform !== "linux") {
    return;
  }
  await withTempDirectory(async (directory) => {
    const keySpecPath = join(directory, "host-key.json");
    const readyPath = join(directory, "live-owner-ready.json");
    const hostKey = key("live-owner-host-key");
    await writeFile(keySpecPath, JSON.stringify(hostKey), "utf8");
    await writeFile(
      join(directory, "known_hosts"),
      `[ssh.example.test]:2222 ${hostKey.keyType} ${hostKey.key}\n`,
      "utf8",
    );

    const child = spawnCredentialOwner(directory, keySpecPath, readyPath, "hold");
    try {
      const ready = await waitForJsonFile(readyPath);
      assert.equal(ready.sessions.length, 1);
      const credentialDirectory = join(directory, "sessions", ready.sessions[0]);
      const recovery = adapter(
        directory,
        keySpecPath,
        join(directory, "live-recovery-ssh-args.json"),
      );
      await recovery.initializeCredentialRecovery();
      assert.match(
        await readFile(join(credentialDirectory, "identity"), "utf8"),
        /crash-fixture-private-material/,
      );
    } finally {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }

    const afterExit = adapter(
      directory,
      keySpecPath,
      join(directory, "after-exit-ssh-args.json"),
    );
    await afterExit.initializeCredentialRecovery();
    assert.deepEqual(await directoryEntriesOrEmpty(join(directory, "sessions")), []);
  });
});

test("interrupted recursive cleanup keeps external deletion authority until remaining secrets are gone", async () => {
  if (process.platform !== "win32" && process.platform !== "linux") {
    return;
  }
  await withTempDirectory(async (directory) => {
    const keySpecPath = join(directory, "host-key.json");
    const readyPath = join(directory, "partial-cleanup-ready.json");
    const hostKey = key("partial-cleanup-host-key");
    await writeFile(keySpecPath, JSON.stringify(hostKey), "utf8");
    await writeFile(
      join(directory, "known_hosts"),
      `[ssh.example.test]:2222 ${hostKey.keyType} ${hostKey.key}\n`,
      "utf8",
    );

    const child = spawnCredentialOwner(directory, keySpecPath, readyPath, "hold");
    let credentialId;
    try {
      const ready = await waitForJsonFile(readyPath);
      assert.equal(ready.sessions.length, 1);
      credentialId = ready.sessions[0];
      const sessionsRoot = join(directory, "sessions");
      const credentialDirectory = join(sessionsRoot, credentialId);
      const ownerPath = join(sessionsRoot, `${credentialId}.owner.json`);
      assert.match(await readFile(ownerPath, "utf8"), /"processIdentity"/);
      assert.match(
        await readFile(join(credentialDirectory, "identity"), "utf8"),
        /crash-fixture-private-material/,
      );
      await rm(join(credentialDirectory, "password"), { force: true });
      await rm(join(credentialDirectory, "askpass.cjs"), { force: true });
      assert.match(await readFile(ownerPath, "utf8"), /"processIdentity"/);
    } finally {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }

    const recovery = adapter(
      directory,
      keySpecPath,
      join(directory, "partial-recovery-ssh-args.json"),
    );
    await recovery.initializeCredentialRecovery();
    assert.deepEqual(await directoryEntriesOrEmpty(join(directory, "sessions")), []);
  });
});

test("legacy ownerless SSH credential directories are never auto-purged", async () => {
  await withTempDirectory(async (directory) => {
    const keySpecPath = join(directory, "host-key.json");
    const sessionsRoot = join(directory, "sessions");
    const legacyDirectory = join(sessionsRoot, "legacy-pre-0.2.0");
    await mkdir(legacyDirectory, { recursive: true });
    await writeFile(join(legacyDirectory, "identity"), "legacy-material", "utf8");
    await writeFile(keySpecPath, JSON.stringify(key("legacy-owner-host-key")), "utf8");

    const recovery = adapter(
      directory,
      keySpecPath,
      join(directory, "legacy-recovery-ssh-args.json"),
    );
    await recovery.initializeCredentialRecovery();
    assert.equal(
      await readFile(join(legacyDirectory, "identity"), "utf8"),
      "legacy-material",
    );
  });
});

test("Windows ACL hardening fails before temporary SSH secret material is written", async () => {
  if (process.platform !== "win32") {
    return;
  }
  await withTempDirectory(async (directory) => {
    const keySpecPath = join(directory, "host-key.json");
    const hostKey = key("acl-failure-host-key");
    await writeFile(keySpecPath, JSON.stringify(hostKey), "utf8");
    await writeFile(
      join(directory, "known_hosts"),
      `[ssh.example.test]:2222 ${hostKey.keyType} ${hostKey.key}\n`,
      "utf8",
    );
    const access = new OpenSshAccessAdapter({
      knownHostsPath: join(directory, "known_hosts"),
      keyscanCommand: {
        executable: process.execPath,
        prefixArgs: [fakeKeyscan, keySpecPath],
      },
      icaclsCommand: {
        executable: process.execPath,
        prefixArgs: ["-e", "process.exit(7)"],
      },
    });
    const setup = setupContext({
      async resolveSecret() {
        return "fixture-secret-that-must-not-be-written";
      },
    });

    await assert.rejects(() =>
      access.openTcpForward(
        sshMethod("secret:550e8400-e29b-41d4-a716-446655440000"),
        "remote-1",
        { host: "127.0.0.1", port: 8000 },
        setup.context,
      ),
    );
    assert.deepEqual(await directoryEntriesOrEmpty(join(directory, "sessions")), []);
  });
});
