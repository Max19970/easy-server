import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAccessMethods } from "@easyai101/easyserver-plugin-sdk";
import { OpenSshAccessAdapter } from "../../dist/ssh-access-adapter.js";

const fakeKeyscan = fileURLToPath(
  new URL("./fake-ssh-keyscan.mjs", import.meta.url),
);
const noopCommand = fileURLToPath(
  new URL("./noop-command.mjs", import.meta.url),
);

const [, , directory, keySpecPath, readyPath, mode = "exit"] = process.argv;
if (directory === undefined || keySpecPath === undefined || readyPath === undefined) {
  process.exitCode = 2;
} else {
  const adapter = new OpenSshAccessAdapter({
    knownHostsPath: join(directory, "known_hosts"),
    keyscanCommand: {
      executable: process.execPath,
      prefixArgs: [fakeKeyscan, keySpecPath],
    },
    sshCommand: {
      executable: process.execPath,
      prefixArgs: ["-e", "process.exit(0)"],
    },
    icaclsCommand: {
      executable: process.execPath,
      prefixArgs: [noopCommand],
    },
  });
  const method = parseAccessMethods([
    {
      id: "fixture-private-key",
      kind: "ssh",
      mode: "tcp-forward",
      credentialSources: [
        { kind: "provider-deferred", id: "ssh-password" },
      ],
      ssh: {
        host: "ssh.example.test",
        port: 2222,
        username: "ubuntu",
        privateKeySecretRef: "secret:550e8400-e29b-41d4-a716-446655440000",
        passwordCredentialId: "ssh-password",
      },
    },
  ])[0];
  const cleanups = [];
  await adapter.openTcpForward(
    method,
    "remote-fixture",
    { host: "127.0.0.1", port: 8000 },
    {
      signal: new AbortController().signal,
      registerCleanup(cleanup) {
        cleanups.push(cleanup);
      },
      async resolveSecret() {
        return "-----BEGIN OPENSSH PRIVATE KEY-----\ncrash-fixture-private-material\n-----END OPENSSH PRIVATE KEY-----";
      },
      async resolveCredential(id) {
        if (id !== "ssh-password") {
          throw new Error(`unexpected credential ${id}`);
        }
        return "crash-fixture-password";
      },
    },
  );
  const sessions = (await readdir(join(directory, "sessions"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  await writeFile(readyPath, `${JSON.stringify({ pid: process.pid, sessions })}\n`, "utf8");

  if (mode === "hold") {
    setInterval(() => undefined, 1_000);
  } else {
    process.exit(0);
  }
}
