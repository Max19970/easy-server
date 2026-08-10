import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  isHostTrustRequiredError,
  parseAccessMethods,
} from "@easycompute/plugin-sdk";
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
const noopCommand = fileURLToPath(
  new URL("./fixtures/noop-command.mjs", import.meta.url),
);
const context = { signal: new AbortController().signal };

async function withTempDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "easycompute-ssh-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function key(value) {
  return {
    keyType: "ssh-ed25519",
    key: Buffer.from(value).toString("base64"),
  };
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
  for (let attempt = 0; attempt < 50; attempt += 1) {
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

async function captureTrustError(run) {
  try {
    await run();
  } catch (error) {
    assert.equal(isHostTrustRequiredError(error), true);
    return error;
  }
  assert.fail("expected host-trust-required");
}

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

test("abrupt OpenSSH child exit fails the channel instead of leaving a dead stream", async () => {
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
      const [error] = await once(channel.stream, "error");
      assert.match(error.message, /OpenSSH channel exited with code 7/);
      assert.match(error.message, /fixture abrupt SSH exit/);
    } finally {
      await channel.close();
      await transport.close();
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
