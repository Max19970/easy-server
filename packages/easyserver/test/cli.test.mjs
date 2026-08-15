import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JsonStateStore } from "../dist/state-store.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const validPlugin = fileURLToPath(
  new URL("./fixtures/valid-plugin.mjs", import.meta.url),
);
const brokenPlugin = fileURLToPath(
  new URL("./fixtures/broken-plugin.mjs", import.meta.url),
);
const credentialPlugin = fileURLToPath(
  new URL("./fixtures/credential-plugin.mjs", import.meta.url),
);
const inventoryPlugin = fileURLToPath(
  new URL("./fixtures/inventory-plugin.mjs", import.meta.url),
);
const providerCliPlugin = fileURLToPath(
  new URL("./fixtures/provider-cli-plugin.mjs", import.meta.url),
);
const daemonPlugin = fileURLToPath(
  new URL("./fixtures/daemon-plugin.mjs", import.meta.url),
);
const rejectTuiRuntime = fileURLToPath(
  new URL("./fixtures/reject-tui-runtime.mjs", import.meta.url),
);
const destroySessionPlugin = fileURLToPath(
  new URL("./fixtures/destroy-session-plugin.mjs", import.meta.url),
);
const intelionPlugin = fileURLToPath(
  new URL("../../../plugins/intelion/dist/index.js", import.meta.url),
);
const partialHealthyPlugin = `data:text/javascript,${encodeURIComponent(`
  export default {
    manifest: {
      id: "fixture.partial-healthy",
      displayName: "Partial Healthy Fixture",
      version: "1.0.0",
      compatibility: { easyserver: "^0.2.0", pluginSdk: "^0.2.0" },
      provider: {
        id: "partial-healthy",
        displayName: "Partial Healthy",
        capabilities: ["instance.stop"],
      },
    },
    provider: {
      providerId: "partial-healthy",
      async listInstances() {
        return [{
          providerExternalId: "healthy-remote",
          name: "Healthy GPU",
          state: "running",
          rawState: "READY",
          availableActions: ["instance.stop"],
        }];
      },
      async getInstance() { return undefined; },
      async performPowerAction() {},
    },
  };
`)}`;
const partialFailingPlugin = `data:text/javascript,${encodeURIComponent(`
  export default {
    manifest: {
      id: "fixture.partial-failing",
      displayName: "Partial Failing Fixture",
      version: "1.0.0",
      compatibility: { easyserver: "^0.2.0", pluginSdk: "^0.2.0" },
      provider: {
        id: "partial-failing",
        displayName: "Partial Failing",
        capabilities: [],
      },
    },
    provider: {
      providerId: "partial-failing",
      async listInstances() {
        throw {
          kind: "easyserver-error",
          code: "provider-unavailable",
          message: "provider-private-payload=must-not-escape",
        };
      },
      async getInstance() { return undefined; },
    },
  };
`)}`;
const incompatiblePlugin = `data:text/javascript,${encodeURIComponent(`
  export default {
    manifest: {
      id: "fixture.incompatible",
      displayName: "Incompatible Fixture",
      version: "1.0.0",
      compatibility: { easyserver: "^0.3.0", pluginSdk: "^0.2.0" },
      provider: {
        id: "incompatible",
        displayName: "Incompatible Provider",
        capabilities: [],
      },
    },
    provider: {
      providerId: "incompatible",
      async listInstances() { return []; },
      async getInstance() { return undefined; },
    },
  };
`)}`;
const providerCollisionPlugin = `data:text/javascript,${encodeURIComponent(`
  export default {
    manifest: {
      id: "fixture.collision",
      displayName: "Provider Collision Fixture",
      version: "1.0.0",
      compatibility: { easyserver: "^0.2.0", pluginSdk: "^0.2.0" },
      provider: {
        id: "fixture",
        displayName: "Fixture Provider",
        capabilities: [],
      },
    },
    provider: {
      providerId: "fixture",
      async listInstances() { return []; },
      async getInstance() { return undefined; },
    },
  };
`)}`;
const unsafeProviderExternalId = "remote\nforged\r\u001b[31m";
const unsafeFeatureDisplayName = "Unsafe\nFeature\u001b[2J";
const unsafeCommandDescription = "Unsafe\rDescription\u001b[31m";
const terminalOutputPlugin = `data:text/javascript,${encodeURIComponent(`
  const externalId = ${JSON.stringify(unsafeProviderExternalId)};
  export default {
    manifest: {
      id: "fixture.terminal-output",
      displayName: "Terminal Output Fixture",
      version: "1.0.0",
      compatibility: { easyserver: "^0.2.0", pluginSdk: "^0.2.0" },
      provider: {
        id: "terminal-output",
        displayName: "Terminal Output Provider",
        capabilities: [],
      },
    },
    provider: {
      providerId: "terminal-output",
      async listInstances() {
        return [{
          providerExternalId: externalId,
          state: "running",
          rawState: "READY",
          availableActions: [],
        }];
      },
      async getInstance(providerExternalId) {
        return providerExternalId === externalId
          ? {
              providerExternalId: externalId,
              state: "running",
              rawState: "READY",
              availableActions: [],
            }
          : undefined;
      },
    },
    features: [{
      id: "marketplace",
      displayName: ${JSON.stringify(unsafeFeatureDisplayName)},
      cli: {
        commands: [{
          name: "show",
          description: ${JSON.stringify(unsafeCommandDescription)},
          operation: "read",
          async run() {},
        }],
      },
    }],
  };
`)}`;
const testDirectory = await mkdtemp(join(tmpdir(), "easyserver-cli-"));
const emptyStateFile = join(testDirectory, "empty-state.json");

after(async () => {
  await rm(testDirectory, { recursive: true, force: true });
});

function run(...args) {
  return runWithState(emptyStateFile, ...args);
}

function runWithState(stateFile, ...args) {
  return runWithStateEnv(stateFile, {}, ...args);
}

function runWithStateEnv(stateFile, extraEnv, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv, EASYSERVER_STATE_FILE: stateFile },
  });
}

function runWithoutTuiRuntime(...args) {
  return spawnSync(
    process.execPath,
    ["--import", pathToFileURL(rejectTuiRuntime).href, cli, ...args],
    {
      encoding: "utf8",
      env: { ...process.env, EASYSERVER_STATE_FILE: emptyStateFile },
    },
  );
}

function runWithDaemon(stateFile, daemonFile, ...args) {
  return runWithDaemonEnv(stateFile, daemonFile, {}, ...args);
}

function runWithDaemonEnv(stateFile, daemonFile, extraEnv, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnv,
      EASYSERVER_STATE_FILE: stateFile,
      EASYSERVER_DAEMON_FILE: daemonFile,
    },
  });
}

function startWithDaemon(stateFile, daemonFile, extraEnv, ...args) {
  const child = spawn(process.execPath, [cli, ...args], {
    env: {
      ...process.env,
      ...extraEnv,
      EASYSERVER_STATE_FILE: stateFile,
      EASYSERVER_DAEMON_FILE: daemonFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return { child, output: () => ({ stdout, stderr }) };
}

async function finishCommand(command) {
  const [code, signal] = await once(command.child, "exit");
  return { status: code, signal, ...command.output() };
}

function startDaemon(stateFile, daemonFile) {
  const child = spawn(process.execPath, [cli, "daemon", "run"], {
    env: {
      ...process.env,
      EASYSERVER_STATE_FILE: stateFile,
      EASYSERVER_DAEMON_FILE: daemonFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return { child, output: () => ({ stdout, stderr }) };
}

function startCli(stateFile, ...args) {
  const child = spawn(process.execPath, [cli, ...args], {
    env: { ...process.env, EASYSERVER_STATE_FILE: stateFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return { child, output: () => ({ stdout, stderr }) };
}

async function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.fail(`file was not created: ${path}`);
}

async function writeDelayedPlugin(pluginPath, startedPath, releasePath, providerId) {
  await writeFile(
    pluginPath,
    `
import { access, writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(startedPath)}, "started", "utf8");
for (;;) {
  try {
    await access(${JSON.stringify(releasePath)});
    break;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
export default {
  manifest: {
    id: ${JSON.stringify(`fixture.delayed.${providerId}`)},
    displayName: "Delayed Fixture",
    version: "1.0.0",
    compatibility: { easyserver: "^0.2.0", pluginSdk: "^0.2.0" },
    provider: {
      id: ${JSON.stringify(providerId)},
      displayName: "Delayed Provider",
      capabilities: [],
    },
  },
  provider: {
    providerId: ${JSON.stringify(providerId)},
    async listInstances() { return []; },
    async getInstance() { return undefined; },
  },
};
`,
    "utf8",
  );
}

async function waitForDaemonFile(
  path,
  daemon,
  timeoutMs = 5000,
  previousAuthToken,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const descriptor = JSON.parse(await readFile(path, "utf8"));
      if (
        previousAuthToken === undefined ||
        descriptor.authToken !== previousAuthToken
      ) {
        return descriptor;
      }
    } catch {
      if (daemon.child.exitCode !== null) {
        assert.fail(`daemon exited early: ${JSON.stringify(daemon.output())}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  assert.fail(`daemon control file was not created: ${JSON.stringify(daemon.output())}`);
}

async function findFreePort() {
  const server = createServer();
  server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function parseEndpoint(output) {
  const match = output.match(/endpoint=(127\.0\.0\.1):(\d+)/);
  assert.ok(match, `missing endpoint in output: ${output}`);
  return { host: match[1], port: Number(match[2]) };
}

async function roundTrip(endpoint, payload) {
  const socket = connect(endpoint);
  await once(socket, "connect");
  const received = new Promise((resolve) => socket.once("data", resolve));
  socket.write(payload);
  const data = await received;
  socket.destroy();
  return data.toString();
}

async function waitForConnectionRefused(endpoint, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const socket = connect(endpoint);
    const outcome = await new Promise((resolve) => {
      socket.once("connect", () => resolve("connected"));
      socket.once("error", () => resolve("error"));
    });
    socket.destroy();
    if (outcome === "error") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`endpoint remained reachable: ${endpoint.host}:${endpoint.port}`);
}

function relativePluginSource(source) {
  const path = relative(process.cwd(), source);
  return process.platform === "win32" ? `.\\${path}` : `./${path}`;
}

test("top-level help explains TUI versus CLI use and every core command group", () => {
  const result = run("--help");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /easyserver\s+Open the interactive TUI/);
  assert.match(result.stdout, /easyserver --help\s+Show this CLI help entrypoint/);
  assert.match(result.stdout, /easyserver --version\s+Print the EasyServer version without starting the TUI/);
  for (const command of [
    "doctor",
    "plugins",
    "instances",
    "connect",
    "daemon",
    "sessions",
    "provider",
  ]) {
    assert.match(result.stdout, new RegExp(`^  ${command}\\s{2}`, "m"));
  }
  assert.match(result.stdout, /Provider-independent compute lifecycle and local connectivity/);
});

test("core help is hierarchical, descriptive and available before Local State or TUI initialization", async () => {
  const malformedStateFile = join(testDirectory, "help-must-not-read-state.json");
  await writeFile(malformedStateFile, "this is deliberately not json", "utf8");

  for (const [path, expected] of [
    [["plugins", "credential", "set"], /Secret Store/],
    [["instances", "destroy"], /Permanently release one or more managed Compute Instances/],
    [["connect"], /foreground localhost Endpoint/],
    [["daemon", "stop"], /Persistent desired Endpoint intents remain durable/],
    [["sessions", "intents"], /durable desired Endpoint definitions/],
    [["sessions", "create"], /daemon-owned persistent Connection Session/],
  ]) {
    const result = runWithState(malformedStateFile, ...path, "--help");
    assert.equal(result.status, 0, `${path.join(" ")}: ${result.stderr}`);
    assert.match(result.stdout, expected);
    assert.match(result.stdout, new RegExp(`Usage:\\n  easyserver ${path.join(" ")}`));
  }

  const withoutInk = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(rejectTuiRuntime).href, cli, "instances", "destroy", "--help"],
    {
      encoding: "utf8",
      env: { ...process.env, EASYSERVER_STATE_FILE: malformedStateFile },
    },
  );
  assert.equal(withoutInk.status, 0, withoutInk.stderr);
  assert.match(withoutInk.stdout, /--close-sessions/);

  const withoutNativeAddons = spawnSync(
    process.execPath,
    ["--no-addons", cli, "--help"],
    {
      encoding: "utf8",
      env: { ...process.env, EASYSERVER_STATE_FILE: malformedStateFile },
    },
  );
  assert.equal(withoutNativeAddons.status, 0, withoutNativeAddons.stderr);
  assert.match(withoutNativeAddons.stdout, /EasyServer/);
});

test("usage errors point to the deepest relevant contextual help page", () => {
  const destroy = run("instances", "destroy");
  assert.equal(destroy.status, 1);
  assert.match(destroy.stderr, /See: easyserver instances destroy --help/);
  assert.doesNotMatch(destroy.stderr, /^Usage:/m);

  const intents = run("sessions", "intents", "wat");
  assert.equal(intents.status, 1);
  assert.match(intents.stderr, /See: easyserver sessions intents --help/);

  const unknown = run("definitely-not-a-command");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /See: easyserver --help/);
  assert.doesNotMatch(unknown.stderr, /^Usage:/m);

  const unknownNestedHelp = runWithState(
    testDirectory,
    "instances",
    "definitely-not-a-command",
    "--help",
  );
  assert.equal(unknownNestedHelp.status, 1);
  assert.match(unknownNestedHelp.stderr, /Unknown help topic: instances definitely-not-a-command/);
  assert.match(unknownNestedHelp.stderr, /See: easyserver instances --help/);
  assert.match(unknownNestedHelp.stdout, /EasyServer · instances/);
  assert.doesNotMatch(unknownNestedHelp.stderr, /EISDIR/);
});

test("no-argument non-TTY invocation fails without terminal control output", () => {
  const result = run();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /interactive terminal/i);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /\u001b\[/);
});

test("prints version", () => {
  const result = run("--version");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "0.2.0\n");
});

test("global --json emits version and help through the stable success envelope", () => {
  const humanHelp = run("--help");
  assert.equal(humanHelp.status, 0, humanHelp.stderr);
  assert.match(humanHelp.stdout, /easyserver --json <command>/);
  assert.match(humanHelp.stdout, /must appear before the command/);

  const version = run("--json", "--version");
  assert.equal(version.status, 0, version.stderr);
  assert.deepEqual(JSON.parse(version.stdout), {
    schemaVersion: 1,
    ok: true,
    data: { version: "0.2.0" },
  });
  assert.equal(version.stderr, "");

  const help = run("--json", "instances", "--help");
  assert.equal(help.status, 0, help.stderr);
  const envelope = JSON.parse(help.stdout);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.ok, true);
  assert.match(envelope.data.help, /EasyServer · instances/);
  assert.equal(help.stderr, "");
});

test("global --json emits one structured usage error without human help text", () => {
  const result = run("--json", "instances", "definitely-not-a-command");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    schemaVersion: 1,
    ok: false,
    error: {
      code: "usage-error",
      message: "Unknown instances command: definitely-not-a-command",
      helpCommand: "easyserver instances --help",
    },
  });
});

test("bare --json fails as structured command-mode usage instead of launching the TUI", () => {
  const result = runWithoutTuiRuntime("--json");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    schemaVersion: 1,
    ok: false,
    error: {
      code: "usage-error",
      message: "--json requires a command",
      helpCommand: "easyserver --help",
    },
  });
});

test("command mode never initializes the React or Ink runtime", () => {
  const helpResult = runWithoutTuiRuntime("--help");
  assert.equal(helpResult.status, 0, helpResult.stderr);
  assert.match(helpResult.stdout, /EasyServer/);

  const versionResult = runWithoutTuiRuntime("--version");
  assert.equal(versionResult.status, 0, versionResult.stderr);
  assert.equal(versionResult.stdout, "0.2.0\n");

  const namedCommandResult = runWithoutTuiRuntime("plugins", "list");
  assert.equal(namedCommandResult.status, 0, namedCommandResult.stderr);
  assert.match(namedCommandResult.stdout, /No provider plugins configured/);
});

test("doctor emits a privacy-safe troubleshooting payload", async () => {
  const stateFile = join(testDirectory, "doctor-state.json");
  const daemonFile = join(testDirectory, "doctor-daemon.json");
  const secretRef = "secret:550e8400-e29b-41d4-a716-446655440000";
  const providerExternalId = "remote-private-4815162342";
  await writeFile(
    stateFile,
    `${JSON.stringify({
      version: 1,
      plugins: [
        {
          source: validPlugin,
          enabled: true,
          credentials: [{ name: "apiToken", secretRef }],
        },
      ],
      instances: [
        {
          id: "instance:550e8400-e29b-41d4-a716-446655440001",
          providerId: "fixture",
          providerExternalId,
        },
      ],
    })}\n`,
    "utf8",
  );

  const result = runWithDaemon(stateFile, daemonFile, "doctor");
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.easyserver.version, "0.2.0");
  assert.equal(report.state.configuredPlugins, 1);
  assert.equal(report.state.credentialBindings, 1);
  assert.equal(report.state.instanceBindings, 1);
  assert.deepEqual(report.plugins, [
    {
      identity: "fixture.plugin",
      state: "loaded",
      version: "1.0.0",
      providerId: "fixture",
    },
  ]);
  assert.deepEqual(report.daemon, { status: "stopped" });
  assert.equal(result.stdout.includes(secretRef), false);
  assert.equal(result.stdout.includes(providerExternalId), false);
  assert.equal(result.stdout.includes(validPlugin), false);
});

test("published CLI entrypoint is directly executable by Node-compatible shells", async () => {
  assert.match(await readFile(cli, "utf8"), /^#!\/usr\/bin\/env node\r?\n/);
});

test("loads first-party workspace packages as explicit provider plugins", () => {
  for (const [source, providerId, credentialName] of [
    ["@easyai101/easyserver-plugin-vastai", "vastai", "api-key"],
    [intelionPlugin, "intelion", "api-token"],
  ]) {
    const result = run("plugins", "list", "--plugin", source);
    assert.equal(result.status, 0);
    assert.match(
      result.stdout,
      new RegExp(
        `^loaded\\s+${providerId} provider=${providerId} credentials=missing:${credentialName}$`,
        "m",
      ),
    );
  }
});

test("first-party provider command help needs no configured credentials or provider work", () => {
  const stateFile = join(testDirectory, "provider-command-help-state.json");
  assert.equal(
    runWithState(
      stateFile,
      "plugins",
      "add",
      "@easyai101/easyserver-plugin-vastai",
    ).status,
    0,
  );
  assert.equal(
    runWithState(
      stateFile,
      "plugins",
      "add",
      "@easyai101/easyserver-plugin-intelion",
    ).status,
    0,
  );

  const vastProviderHelp = runWithState(
    stateFile,
    "provider",
    "vastai",
    "--help",
  );
  assert.equal(vastProviderHelp.status, 0, vastProviderHelp.stderr);
  assert.match(vastProviderHelp.stdout, /Vast\.ai \(vastai\)/);
  assert.match(vastProviderHelp.stdout, /^  marketplace\s+Marketplace$/m);

  const vastFeatureHelp = runWithState(
    stateFile,
    "provider",
    "vastai",
    "marketplace",
    "--help",
  );
  assert.equal(vastFeatureHelp.status, 0, vastFeatureHelp.stderr);
  assert.match(vastFeatureHelp.stdout, /Provider-owned CLI commands/);
  assert.match(vastFeatureHelp.stdout, /^  search\s+Search Vast\.ai marketplace offers$/m);
  assert.match(vastFeatureHelp.stdout, /^  rent\s+Rent a Vast\.ai marketplace offer$/m);

  const vastHelp = runWithState(
    stateFile,
    "provider",
    "vastai",
    "marketplace",
    "rent",
    "--help",
  );
  assert.equal(vastHelp.status, 0, vastHelp.stderr);
  assert.match(
    vastHelp.stdout,
    /easyserver provider vastai marketplace rent \[--yes\] <offer-id> --image <image>/,
  );
  assert.match(vastHelp.stdout, /--image <image> \(required\)/);
  assert.match(vastHelp.stdout, /Risks: billable/);
  assert.match(vastHelp.stdout, /non-interactive calls require --yes/);
  assert.doesNotMatch(vastHelp.stderr, /credential|authentication/i);

  const intelionProviderHelp = runWithState(
    stateFile,
    "provider",
    "intelion",
    "--help",
  );
  assert.equal(intelionProviderHelp.status, 0, intelionProviderHelp.stderr);
  assert.match(intelionProviderHelp.stdout, /Intelion\.cloud \(intelion\)/);

  const intelionHelp = runWithState(
    stateFile,
    "provider",
    "intelion",
    "server-configurator",
    "create",
    "-h",
  );
  assert.equal(intelionHelp.status, 0, intelionHelp.stderr);
  assert.match(
    intelionHelp.stdout,
    /easyserver provider intelion server-configurator create \[--yes\] --name <name> --flavor <id> --disk <gb> --os <id>/,
  );
  assert.match(intelionHelp.stdout, /--addon <id> \(optional, repeatable\)/);
  assert.match(intelionHelp.stdout, /Risks: billable/);
  assert.doesNotMatch(intelionHelp.stderr, /credential|authentication/i);

  const providerUsageError = runWithState(
    stateFile,
    "provider",
    "vastai",
    "marketplace",
    "rent",
    "--yes",
  );
  assert.equal(providerUsageError.status, 1);
  assert.match(providerUsageError.stderr, /Vast marketplace rent requires <offer-id>/);
  assert.match(
    providerUsageError.stderr,
    /See: easyserver provider vastai marketplace rent --help/,
  );

  const unknownCommand = runWithState(
    stateFile,
    "provider",
    "vastai",
    "marketplace",
    "not-a-command",
  );
  assert.equal(unknownCommand.status, 1);
  assert.match(
    unknownCommand.stderr,
    /See: easyserver provider vastai marketplace --help/,
  );
});

test("lists zero configured plugins", () => {
  const result = run("plugins", "list");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "No provider plugins configured.\n");
});

test("loads enabled plugins from persistent state and keeps disabled ones inert", async () => {
  const stateFile = join(testDirectory, "configured-state.json");
  await writeFile(
    stateFile,
    `${JSON.stringify({
      version: 1,
      plugins: [
        { source: validPlugin, enabled: true },
        { source: brokenPlugin, enabled: false },
      ],
    })}\n`,
    "utf8",
  );

  const result = runWithState(stateFile, "plugins", "list");

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^loaded\s+fixture\.plugin provider=fixture/m);
  assert.match(result.stdout, /^disabled\s+.*broken-plugin\.mjs/m);
  assert.doesNotMatch(result.stdout, /fixture load failure/);
});

test("plugin configuration survives separate CLI processes", () => {
  const stateFile = join(testDirectory, "managed-state.json");

  const add = runWithState(stateFile, "plugins", "add", validPlugin);
  assert.equal(add.status, 0);
  assert.match(add.stdout, /Added fixture\.plugin/);

  const firstList = runWithState(stateFile, "plugins", "list");
  assert.equal(firstList.status, 0);
  assert.match(firstList.stdout, /^loaded\s+fixture\.plugin provider=fixture/m);

  const disable = runWithState(stateFile, "plugins", "disable", validPlugin);
  assert.equal(disable.status, 0);

  const disabledList = runWithState(stateFile, "plugins", "list");
  assert.equal(disabledList.status, 0);
  assert.match(disabledList.stdout, /^disabled\s+.*valid-plugin\.mjs/m);
  assert.doesNotMatch(disabledList.stdout, /^loaded\s+fixture\.plugin/m);

  const enable = runWithState(stateFile, "plugins", "enable", validPlugin);
  assert.equal(enable.status, 0);

  const enabledList = runWithState(stateFile, "plugins", "list");
  assert.equal(enabledList.status, 0);
  assert.match(enabledList.stdout, /^loaded\s+fixture\.plugin provider=fixture/m);
});

test("plugin credential command never requires the secret in argv", () => {
  const stateFile = join(testDirectory, "credential-command-state.json");
  const add = runWithState(
    stateFile,
    "plugins",
    "add",
    "@easyai101/easyserver-plugin-vastai",
  );
  assert.equal(add.status, 0);

  const missingEnv = runWithState(
    stateFile,
    "plugins",
    "credential",
    "set",
    "@easyai101/easyserver-plugin-vastai",
    "api-key",
    "--env",
    "EASYSERVER_TEST_SECRET_INTENTIONALLY_MISSING_7CFB",
  );
  assert.equal(missingEnv.status, 1);
  assert.match(missingEnv.stderr, /Environment variable is empty or missing/);
});

test("plugins list exposes declared credential readiness without secret values", async () => {
  const stateFile = join(testDirectory, "credential-readiness-state.json");
  const secretRef = "secret:550e8400-e29b-41d4-a716-446655440000";
  const store = new JsonStateStore(stateFile);
  await store.write({
    version: 1,
    plugins: [{ source: credentialPlugin, enabled: true }],
  });

  const missing = runWithState(stateFile, "plugins", "list");
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(
    missing.stdout,
    /^loaded\s+fixture\.credentials provider=credential-fixture credentials=missing:api-key$/m,
  );

  await store.write({
    version: 1,
    plugins: [
      {
        source: credentialPlugin,
        enabled: true,
        credentials: [{ name: "api-key", secretRef }],
      },
    ],
  });
  const ready = runWithState(stateFile, "plugins", "list");
  assert.equal(ready.status, 0, ready.stderr);
  assert.match(
    ready.stdout,
    /^loaded\s+fixture\.credentials provider=credential-fixture credentials=ready$/m,
  );
  assert.equal(ready.stdout.includes(secretRef), false);
});

test("credential set rejects undeclared names before touching the OS keyring", async () => {
  const stateFile = join(testDirectory, "credential-typo-state.json");
  assert.equal(
    runWithState(stateFile, "plugins", "add", credentialPlugin).status,
    0,
  );

  const result = runWithStateEnv(
    stateFile,
    { EASYSERVER_TEST_CREDENTIAL_VALUE: "never-store-this" },
    "plugins",
    "credential",
    "set",
    credentialPlugin,
    "api-kye",
    "--env",
    "EASYSERVER_TEST_CREDENTIAL_VALUE",
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not declare credential api-kye/);
  assert.match(result.stderr, /Allowed credentials: api-key, profile/);
  assert.equal(result.stderr.includes("never-store-this"), false);
  const persisted = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(persisted.plugins[0].credentials, undefined);
});

test("enable and disable preserve provider credential references", async () => {
  const stateFile = join(testDirectory, "credential-state.json");
  const secretRef = "secret:550e8400-e29b-41d4-a716-446655440000";
  await writeFile(
    stateFile,
    `${JSON.stringify({
      version: 1,
      plugins: [
        {
          source: validPlugin,
          enabled: true,
          credentials: [{ name: "apiToken", secretRef }],
        },
      ],
    })}\n`,
    "utf8",
  );

  assert.equal(
    runWithState(stateFile, "plugins", "disable", validPlugin).status,
    0,
  );
  assert.equal(
    runWithState(stateFile, "plugins", "enable", validPlugin).status,
    0,
  );

  const persisted = JSON.parse(await readFile(stateFile, "utf8"));
  assert.deepEqual(persisted.plugins[0].credentials, [
    { name: "apiToken", secretRef },
  ]);
});

test("plugins add rejects collisions with enabled configured plugins", () => {
  const stateFile = join(testDirectory, "collision-state.json");

  const first = runWithState(stateFile, "plugins", "add", validPlugin);
  assert.equal(first.status, 0);

  const second = runWithState(
    stateFile,
    "plugins",
    "add",
    providerCollisionPlugin,
  );
  assert.equal(second.status, 1);
  assert.match(second.stderr, /Provider already registered: fixture/);

  const list = runWithState(stateFile, "plugins", "list");
  assert.equal(list.status, 0);
  assert.equal(
    list.stdout.match(/^loaded\s+fixture\.plugin provider=fixture$/gm)?.length,
    1,
  );
  assert.doesNotMatch(list.stdout, /^failed\s+/m);
});

test("plugins enable rejects collisions with enabled configured plugins", () => {
  const stateFile = join(testDirectory, "enable-collision-state.json");

  assert.equal(
    runWithState(stateFile, "plugins", "add", validPlugin).status,
    0,
  );
  assert.equal(
    runWithState(stateFile, "plugins", "disable", validPlugin).status,
    0,
  );
  assert.equal(
    runWithState(stateFile, "plugins", "add", providerCollisionPlugin).status,
    0,
  );

  const enable = runWithState(stateFile, "plugins", "enable", validPlugin);
  assert.equal(enable.status, 1);
  assert.match(enable.stderr, /Provider already registered: fixture/);

  const list = runWithState(stateFile, "plugins", "list");
  assert.equal(list.status, 0);
  assert.match(list.stdout, /^loaded\s+fixture\.collision provider=fixture/m);
  assert.match(list.stdout, /^disabled\s+.*valid-plugin\.mjs/m);
  assert.doesNotMatch(list.stdout, /^failed\s+/m);
});

test("plugins list canonicalizes configured and explicit local paths", () => {
  const stateFile = join(testDirectory, "canonical-state.json");
  assert.equal(
    runWithState(stateFile, "plugins", "add", validPlugin).status,
    0,
  );

  const list = runWithState(
    stateFile,
    "plugins",
    "list",
    "--plugin",
    relativePluginSource(validPlugin),
  );

  assert.equal(list.status, 0);
  assert.equal(
    list.stdout.match(/^loaded\s+fixture\.plugin provider=fixture$/gm)?.length,
    1,
  );
  assert.doesNotMatch(list.stdout, /^failed\s+/m);
});

test("broken plugins are not persisted by plugins add", () => {
  const stateFile = join(testDirectory, "rejected-state.json");
  const add = runWithState(stateFile, "plugins", "add", brokenPlugin);

  assert.equal(add.status, 1);
  assert.match(add.stderr, /fixture load failure/);

  const list = runWithState(stateFile, "plugins", "list");
  assert.equal(list.status, 0);
  assert.equal(list.stdout, "No provider plugins configured.\n");
});

test("configured incompatible plugin fails without rewriting durable state", async () => {
  const stateFile = join(testDirectory, "incompatible-configured-state.json");
  const persisted = `${JSON.stringify({
    version: 1,
    plugins: [
      {
        source: incompatiblePlugin,
        enabled: true,
        credentials: [
          {
            name: "api-key",
            secretRef: "secret:550e8400-e29b-41d4-a716-446655440000",
          },
        ],
      },
    ],
    instances: [
      {
        id: "instance:550e8400-e29b-41d4-a716-446655440001",
        providerId: "incompatible",
        providerExternalId: "remote-1",
      },
    ],
  })}\n`;
  await writeFile(stateFile, persisted, "utf8");

  const list = runWithState(stateFile, "plugins", "list");

  assert.equal(list.status, 0);
  assert.match(list.stdout, /^failed\s+data:text\/javascript,.*requires EasyServer \^0\.3\.0/m);
  assert.equal(await readFile(stateFile, "utf8"), persisted);
});

test("hung plugin validation does not hold the Local State lock", async () => {
  const stateFile = join(testDirectory, "hung-validation-state.json");
  const pluginPath = join(testDirectory, "delayed-independent-plugin.mjs");
  const startedPath = join(testDirectory, "delayed-independent.started");
  const releasePath = join(testDirectory, "delayed-independent.release");
  await writeDelayedPlugin(pluginPath, startedPath, releasePath, "delayed-independent");
  const operation = startCli(stateFile, "plugins", "add", pluginPath);

  try {
    await waitForFile(startedPath);
    const independent = new JsonStateStore(stateFile).update((state) => ({
      ...state,
      instances: [
        ...(state.instances ?? []),
        {
          id: "instance:f3e4bc3a-b59c-43db-b218-6bc77bb06acd",
          providerId: "fixture",
          providerExternalId: "remote-independent",
        },
      ],
    }));
    const outcome = await Promise.race([
      independent.then(() => "committed"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 300)),
    ]);
    assert.equal(outcome, "committed");

    await writeFile(releasePath, "release", "utf8");
    const [code] = await once(operation.child, "exit");
    assert.equal(code, 0, JSON.stringify(operation.output()));
    assert.equal((await new JsonStateStore(stateFile).read()).instances?.length, 1);
  } finally {
    await writeFile(releasePath, "release", "utf8").catch(() => undefined);
    if (operation.child.exitCode === null) {
      operation.child.kill();
      await once(operation.child, "exit").catch(() => undefined);
    }
  }
});

test("plugin activation revalidates concurrent enabled-provider changes", async () => {
  const stateFile = join(testDirectory, "activation-revalidation-state.json");
  const pluginPath = join(testDirectory, "delayed-collision-plugin.mjs");
  const startedPath = join(testDirectory, "delayed-collision.started");
  const releasePath = join(testDirectory, "delayed-collision.release");
  await writeDelayedPlugin(pluginPath, startedPath, releasePath, "fixture");
  const operation = startCli(stateFile, "plugins", "add", pluginPath);

  try {
    await waitForFile(startedPath);
    const competing = new JsonStateStore(stateFile).update((state) => ({
      ...state,
      plugins: [...state.plugins, { source: validPlugin, enabled: true }],
    }));
    const outcome = await Promise.race([
      competing.then(() => "committed"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 300)),
    ]);
    assert.equal(outcome, "committed");

    await writeFile(releasePath, "release", "utf8");
    const [code] = await once(operation.child, "exit");
    assert.equal(code, 1);
    assert.match(operation.output().stderr, /Provider already registered: fixture/);
    assert.deepEqual((await new JsonStateStore(stateFile).read()).plugins, [
      { source: validPlugin, enabled: true },
    ]);
  } finally {
    await writeFile(releasePath, "release", "utf8").catch(() => undefined);
    if (operation.child.exitCode === null) {
      operation.child.kill();
      await once(operation.child, "exit").catch(() => undefined);
    }
  }
});

test("lists healthy and broken explicitly requested plugins", () => {
  const result = run(
    "plugins",
    "list",
    "--plugin",
    validPlugin,
    "--plugin",
    brokenPlugin,
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^loaded\s+fixture\.plugin provider=fixture/m);
  assert.match(result.stdout, /^failed\s+.*broken-plugin\.mjs error=fixture load failure/m);
});

test("lists and inspects compute instances through configured providers", () => {
  const stateFile = join(testDirectory, "instances-state.json");
  assert.equal(
    runWithState(stateFile, "plugins", "add", inventoryPlugin).status,
    0,
  );

  const firstList = runWithState(stateFile, "instances", "list");
  assert.equal(firstList.status, 0);
  assert.match(
    firstList.stdout,
    /provider=inventory external=remote-1 management=discovered freshness=fresh state=running/,
  );
  assert.match(firstList.stdout, /actions=instance\.stop/);
  const [instanceId] = firstList.stdout.match(/instance:[0-9a-f-]+/i) ?? [];
  assert.ok(instanceId);

  const secondList = runWithState(stateFile, "instances", "list");
  assert.equal(secondList.status, 0);
  assert.match(secondList.stdout, new RegExp(instanceId));

  const inspect = runWithState(stateFile, "instances", "inspect", instanceId);
  assert.equal(inspect.status, 0);
  assert.deepEqual(JSON.parse(inspect.stdout), {
    id: instanceId,
    providerId: "inventory",
    providerExternalId: "remote-1",
    management: "discovered",
    state: "running",
    rawState: "READY",
    availableActions: ["instance.stop"],
    name: "Fixture GPU",
  });

  const waitRunning = runWithState(
    stateFile,
    "instances",
    "wait",
    instanceId,
    "--state",
    "running",
    "--timeout",
    "1",
  );
  assert.equal(waitRunning.status, 0, waitRunning.stderr);
  assert.equal(waitRunning.stdout, `Reached state=running for ${instanceId}\n`);

  const invalidWait = runWithState(
    stateFile,
    "instances",
    "wait",
    instanceId,
    "--state",
    "ready-ish",
  );
  assert.equal(invalidWait.status, 1);
  assert.match(invalidWait.stderr, /normalized state/);

  const adopt = runWithState(stateFile, "instances", "adopt", instanceId);
  assert.equal(adopt.status, 0);
  assert.equal(adopt.stdout, `Adopted ${instanceId} for EasyServer management\n`);
  const adoptedInspect = runWithState(stateFile, "instances", "inspect", instanceId);
  assert.equal(adoptedInspect.status, 0);
  assert.equal(JSON.parse(adoptedInspect.stdout).management, "managed");
  assert.equal(JSON.parse(adoptedInspect.stdout).id, instanceId);

  const stop = runWithState(stateFile, "instances", "stop", instanceId);
  assert.equal(stop.status, 0);
  assert.equal(stop.stdout, `Requested instance.stop for ${instanceId}\n`);

  const start = runWithState(stateFile, "instances", "start", instanceId);
  assert.equal(start.status, 1);
  assert.match(start.stderr, /conflict: instance\.start is not available/);
});

test("global JSON mode exposes stable core plugin, inventory, lifecycle and error data", () => {
  const stateFile = join(testDirectory, "json-core-state.json");
  const add = runWithState(stateFile, "--json", "plugins", "add", inventoryPlugin);
  assert.equal(add.status, 0, add.stderr);
  assert.deepEqual(JSON.parse(add.stdout), {
    schemaVersion: 1,
    ok: true,
    data: {
      plugin: {
        pluginId: "fixture.inventory",
        source: inventoryPlugin,
      },
    },
  });

  const plugins = JSON.parse(
    runWithState(stateFile, "--json", "plugins", "list").stdout,
  );
  assert.equal(plugins.schemaVersion, 1);
  assert.equal(plugins.ok, true);
  assert.equal(plugins.data.plugins.length, 1);
  assert.equal(plugins.data.plugins[0].state, "loaded");
  assert.equal(plugins.data.plugins[0].providerId, "inventory");

  const listed = runWithState(stateFile, "--json", "instances", "list");
  assert.equal(listed.status, 0, listed.stderr);
  const inventory = JSON.parse(listed.stdout);
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.ok, true);
  assert.equal(inventory.data.inventory.complete, true);
  assert.equal(inventory.data.inventory.instances.length, 1);
  const listedInstance = inventory.data.inventory.instances[0];
  assert.equal(listedInstance.providerId, "inventory");
  assert.equal(listedInstance.providerExternalId, "remote-1");
  assert.equal(listedInstance.name, "Fixture GPU");
  assert.equal(listedInstance.management, "discovered");
  assert.equal(listedInstance.freshness, "fresh");
  assert.equal(listedInstance.state, "running");
  assert.deepEqual(listedInstance.availableActions, ["instance.stop"]);
  assert.match(listedInstance.observedAt, /^\d{4}-\d{2}-\d{2}T/);
  const instanceId = listedInstance.id;

  const inspected = JSON.parse(
    runWithState(stateFile, "--json", "instances", "inspect", instanceId).stdout,
  );
  assert.equal(inspected.ok, true);
  assert.equal(inspected.data.instance.id, instanceId);
  assert.equal(inspected.data.instance.providerExternalId, "remote-1");

  const missingId = "instance:00000000-0000-4000-8000-000000000000";
  const missing = runWithState(
    stateFile,
    "--json",
    "instances",
    "inspect",
    missingId,
  );
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
  assert.deepEqual(JSON.parse(missing.stderr), {
    schemaVersion: 1,
    ok: false,
    error: {
      code: "not-found",
      message: `Compute Instance not found: ${missingId}`,
    },
  });

  const unavailable = runWithState(
    stateFile,
    "--json",
    "instances",
    "start",
    instanceId,
  );
  assert.equal(unavailable.status, 1);
  assert.equal(unavailable.stdout, "");
  const error = JSON.parse(unavailable.stderr);
  assert.equal(error.schemaVersion, 1);
  assert.equal(error.ok, false);
  assert.equal(error.error.code, "conflict");
  assert.match(error.error.message, /instance\.start is not available/);

  const adopted = JSON.parse(
    runWithState(stateFile, "--json", "instances", "adopt", instanceId).stdout,
  );
  assert.deepEqual(adopted.data, { instanceId, management: "managed" });

  const stopped = JSON.parse(
    runWithState(stateFile, "--json", "instances", "stop", instanceId).stdout,
  );
  assert.deepEqual(stopped.data, {
    action: "instance.stop",
    instanceId,
    status: "requested",
    warnings: [],
  });

  const daemonStatus = runWithDaemon(
    stateFile,
    join(testDirectory, "json-stopped-daemon.json"),
    "--json",
    "daemon",
    "status",
  );
  assert.equal(daemonStatus.status, 0, daemonStatus.stderr);
  assert.deepEqual(JSON.parse(daemonStatus.stdout), {
    schemaVersion: 1,
    ok: true,
    data: { daemon: { status: "stopped" } },
  });
});

test("global JSON mode preserves provider-owned command output as namespaced raw transcript", () => {
  const stateFile = join(testDirectory, "json-provider-state.json");
  assert.equal(
    runWithState(stateFile, "plugins", "add", providerCliPlugin).status,
    0,
  );

  const result = runWithState(
    stateFile,
    "--json",
    "provider",
    "provider-cli",
    "marketplace",
    "echo",
    "alpha",
    "beta",
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.data.provider, {
    providerId: "provider-cli",
    featureId: "marketplace",
    commandName: "echo",
    stdout: "provider-owned:alpha|beta\n",
    stderr: "",
  });
  assert.equal(envelope.data.execution.operation, "read");
  assert.equal(envelope.data.execution.mutationOutcome, "not-applicable");
});

test("global JSON mode exposes daemon-owned sessions without display parsing", async () => {
  const stateFile = join(testDirectory, "json-sessions-state.json");
  const daemonFile = join(testDirectory, "json-sessions-daemon.json");
  const daemon = startDaemon(stateFile, daemonFile);
  try {
    await waitForDaemonFile(daemonFile, daemon);
    const result = runWithDaemon(
      stateFile,
      daemonFile,
      "--json",
      "sessions",
      "list",
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      schemaVersion: 1,
      ok: true,
      data: { sessions: [] },
    });
  } finally {
    if (daemon.child.exitCode === null) {
      daemon.child.kill();
      await once(daemon.child, "exit");
    }
  }
});

test("bulk lifecycle accepts multiple explicit instance IDs and reports partial results", () => {
  const stateFile = join(testDirectory, "bulk-instance-state.json");
  assert.equal(
    runWithState(stateFile, "plugins", "add", inventoryPlugin).status,
    0,
  );
  const listed = runWithState(stateFile, "instances", "list");
  assert.equal(listed.status, 0, listed.stderr);
  const [instanceId] = listed.stdout.match(/instance:[0-9a-f-]+/i) ?? [];
  assert.ok(instanceId);
  const missingId = "instance:00000000-0000-4000-8000-000000000000";

  const result = runWithState(
    stateFile,
    "instances",
    "stop",
    instanceId,
    missingId,
  );

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, new RegExp(`${instanceId} status=completed`));
  assert.match(
    result.stdout,
    new RegExp(`${missingId} status=failed code=not-found`),
  );
  assert.match(
    result.stdout,
    /Summary action=instance\.stop requested=2 completed=1 failed=1 outcome-unknown=0/,
  );

  const jsonStateFile = join(testDirectory, "json-bulk-instance-state.json");
  assert.equal(
    runWithState(jsonStateFile, "plugins", "add", inventoryPlugin).status,
    0,
  );
  const jsonList = runWithState(jsonStateFile, "instances", "list");
  const [jsonInstanceId] = jsonList.stdout.match(/instance:[0-9a-f-]+/i) ?? [];
  assert.ok(jsonInstanceId);
  const jsonResult = runWithState(
    jsonStateFile,
    "--json",
    "instances",
    "stop",
    jsonInstanceId,
    missingId,
  );
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  const envelope = JSON.parse(jsonResult.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.result.summary.completed, 1);
  assert.equal(envelope.data.result.summary.failed, 1);
});

test("non-interactive destroy requires --yes before provider dispatch", async () => {
  const stateFile = join(testDirectory, "destroy-confirmation-state.json");
  const pluginPath = join(testDirectory, "destroy-confirmation-plugin.mjs");
  const markerPath = join(testDirectory, "destroy-confirmation-marker.txt");
  const instanceId = "instance:550e8400-e29b-41d4-a716-446655440000";
  await writeFile(
    pluginPath,
    `import { writeFileSync } from "node:fs";
const markerPath = ${JSON.stringify(markerPath)};
const snapshot = {
  providerExternalId: "remote-1",
  state: "stopped",
  rawState: "STOPPED",
  availableActions: ["instance.destroy"],
};
export default {
  manifest: {
    id: "fixture.destroy-confirmation",
    displayName: "Destroy Confirmation Fixture",
    version: "1.0.0",
    compatibility: { easyserver: "^0.2.0", pluginSdk: "^0.2.0" },
    provider: {
      id: "destructive-cli",
      displayName: "Destructive CLI Fixture",
      capabilities: ["instance.destroy"],
    },
  },
  provider: {
    providerId: "destructive-cli",
    async listInstances() { return [snapshot]; },
    async getInstance() { return snapshot; },
    async destroy(providerExternalId, context) {
      context.markMutationDispatched();
      writeFileSync(markerPath, providerExternalId, "utf8");
    },
  },
};\n`,
    "utf8",
  );
  await new JsonStateStore(stateFile).write({
    version: 1,
    plugins: [{ source: pluginPath, enabled: true }],
    instances: [
      {
        id: instanceId,
        providerId: "destructive-cli",
        providerExternalId: "remote-1",
        management: "managed",
      },
    ],
  });

  const blocked = runWithState(stateFile, "instances", "destroy", instanceId);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /requires explicit --yes because it is destructive/);
  await assert.rejects(
    readFile(markerPath, "utf8"),
    (error) => error?.code === "ENOENT",
  );

  const allowed = runWithState(
    stateFile,
    "instances",
    "destroy",
    instanceId,
    "--yes",
  );
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(
    allowed.stdout,
    `Requested instance.destroy for ${instanceId}\n`,
  );
  assert.equal(await readFile(markerPath, "utf8"), "remote-1");
});

test("instance destroy refuses active daemon connections unless coordinated teardown is explicit", async () => {
  const stateFile = join(testDirectory, "destroy-session-state.json");
  const daemonFile = join(testDirectory, "destroy-session-control.json");
  const markerPath = join(testDirectory, "destroy-session-marker.txt");
  const instanceId = "instance:550e8400-e29b-41d4-a716-446655440000";
  await new JsonStateStore(stateFile).write({
    version: 1,
    plugins: [{ source: destroySessionPlugin, enabled: true }],
    instances: [
      {
        id: instanceId,
        providerId: "destroy-session",
        providerExternalId: "remote-1",
        management: "managed",
      },
    ],
  });

  const echo = createServer((socket) => socket.pipe(socket));
  echo.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  await once(echo, "listening");
  const echoAddress = echo.address();
  assert.ok(echoAddress && typeof echoAddress !== "string");
  const env = { EASYSERVER_TEST_DESTROY_MARKER: markerPath };

  try {
    const start = runWithDaemonEnv(
      stateFile,
      daemonFile,
      env,
      "daemon",
      "start",
    );
    assert.equal(start.status, 0, start.stderr);

    const create = runWithDaemon(
      stateFile,
      daemonFile,
      "sessions",
      "create",
      instanceId,
      "--port",
      String(echoAddress.port),
    );
    assert.equal(create.status, 0, create.stderr);
    const sessionId = create.stdout.match(/^(\S+)/m)?.[1];
    const endpointMatch = create.stdout.match(/endpoint=(127\.0\.0\.1):(\d+)/);
    assert.ok(sessionId && endpointMatch, create.stdout);
    const endpoint = { host: endpointMatch[1], port: Number(endpointMatch[2]) };

    const intent = runWithDaemon(
      stateFile,
      daemonFile,
      "sessions",
      "intents",
      "create",
      "destroy-intent",
      instanceId,
      "--port",
      String(echoAddress.port),
    );
    assert.equal(intent.status, 0, intent.stderr);

    const blocked = runWithDaemonEnv(
      stateFile,
      daemonFile,
      env,
      "instances",
      "destroy",
      instanceId,
      "--yes",
    );
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /has EasyServer connections/);
    assert.match(blocked.stderr, new RegExp(sessionId));
    assert.match(blocked.stderr, /destroy-intent/);
    assert.match(blocked.stderr, /--close-sessions/);
    await assert.rejects(
      readFile(markerPath, "utf8"),
      (error) => error?.code === "ENOENT",
    );
    assert.equal(await roundTrip(endpoint, "still-live"), "still-live");

    const coordinated = runWithDaemonEnv(
      stateFile,
      daemonFile,
      env,
      "instances",
      "destroy",
      instanceId,
      "--close-sessions",
      "--yes",
    );
    assert.equal(coordinated.status, 0, coordinated.stderr);
    assert.equal(await readFile(markerPath, "utf8"), "destroyed");
    await waitForConnectionRefused(endpoint);

    const sessions = runWithDaemon(stateFile, daemonFile, "sessions", "list");
    assert.equal(sessions.status, 0, sessions.stderr);
    assert.doesNotMatch(sessions.stdout, new RegExp(sessionId));
    const intents = runWithDaemon(
      stateFile,
      daemonFile,
      "sessions",
      "intents",
      "list",
    );
    assert.equal(intents.status, 0, intents.stderr);
    assert.match(intents.stdout, /destroy-intent state=disabled enabled=false/);
  } finally {
    runWithDaemon(stateFile, daemonFile, "daemon", "stop");
    await new Promise((resolve, reject) =>
      echo.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("coordinated destroy never dispatches provider mutation when session cleanup fails", async () => {
  const stateFile = join(testDirectory, "destroy-session-failure-state.json");
  const daemonFile = join(testDirectory, "destroy-session-failure-control.json");
  const markerPath = join(testDirectory, "destroy-session-failure-marker.txt");
  const closeFailFile = join(testDirectory, "destroy-session-close-fail.txt");
  const instanceId = "instance:550e8400-e29b-41d4-a716-446655440000";
  await writeFile(closeFailFile, "fail", "utf8");
  await new JsonStateStore(stateFile).write({
    version: 1,
    plugins: [{ source: destroySessionPlugin, enabled: true }],
    instances: [
      {
        id: instanceId,
        providerId: "destroy-session",
        providerExternalId: "remote-1",
        management: "managed",
      },
    ],
  });
  const env = {
    EASYSERVER_TEST_DESTROY_MARKER: markerPath,
    EASYSERVER_TEST_SESSION_CLOSE_FAIL_FILE: closeFailFile,
  };

  const echo = createServer((socket) => socket.pipe(socket));
  echo.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  await once(echo, "listening");
  const echoAddress = echo.address();
  assert.ok(echoAddress && typeof echoAddress !== "string");

  try {
    const start = runWithDaemonEnv(
      stateFile,
      daemonFile,
      env,
      "daemon",
      "start",
    );
    assert.equal(start.status, 0, start.stderr);
    const create = runWithDaemon(
      stateFile,
      daemonFile,
      "sessions",
      "create",
      instanceId,
      "--port",
      String(echoAddress.port),
    );
    assert.equal(create.status, 0, create.stderr);

    const destroy = runWithDaemonEnv(
      stateFile,
      daemonFile,
      env,
      "instances",
      "destroy",
      instanceId,
      "--close-sessions",
      "--yes",
    );
    assert.equal(destroy.status, 1);
    assert.match(destroy.stderr, /Failed to close all EasyServer connections/);
    assert.match(destroy.stderr, /destroy was not dispatched/);
    await assert.rejects(
      readFile(markerPath, "utf8"),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await rm(closeFailFile, { force: true });
    runWithDaemon(stateFile, daemonFile, "daemon", "stop");
    await new Promise((resolve, reject) =>
      echo.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("running daemon reloads plugin enablement for new sessions without closing existing ones", async () => {
  const stateFile = join(testDirectory, "daemon-plugin-reload-state.json");
  const daemonFile = join(testDirectory, "daemon-plugin-reload-control.json");
  const instanceId = "instance:550e8400-e29b-41d4-a716-446655440000";
  const echo = createServer((socket) => socket.pipe(socket));
  echo.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  await once(echo, "listening");
  const echoAddress = echo.address();
  assert.ok(echoAddress && typeof echoAddress !== "string");

  await new JsonStateStore(stateFile).write({
    version: 1,
    plugins: [],
    instances: [
      {
        id: instanceId,
        providerId: "destroy-session",
        providerExternalId: "remote-1",
        management: "managed",
      },
    ],
  });

  try {
    const start = runWithDaemon(stateFile, daemonFile, "daemon", "start");
    assert.equal(start.status, 0, start.stderr);

    const beforeAdd = runWithDaemon(
      stateFile,
      daemonFile,
      "sessions",
      "create",
      instanceId,
      "--port",
      String(echoAddress.port),
    );
    assert.equal(beforeAdd.status, 1);
    assert.match(beforeAdd.stderr, /provider-unavailable/);

    const add = runWithState(stateFile, "plugins", "add", destroySessionPlugin);
    assert.equal(add.status, 0, add.stderr);

    const first = runWithDaemon(
      stateFile,
      daemonFile,
      "sessions",
      "create",
      instanceId,
      "--port",
      String(echoAddress.port),
    );
    assert.equal(first.status, 0, first.stderr);
    const firstEndpoint = parseEndpoint(first.stdout);
    assert.equal(await roundTrip(firstEndpoint, "before-disable"), "before-disable");

    const disable = runWithState(
      stateFile,
      "plugins",
      "disable",
      destroySessionPlugin,
    );
    assert.equal(disable.status, 0, disable.stderr);

    const blocked = runWithDaemon(
      stateFile,
      daemonFile,
      "sessions",
      "create",
      instanceId,
      "--port",
      String(echoAddress.port),
    );
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /provider-unavailable/);
    assert.equal(await roundTrip(firstEndpoint, "still-live"), "still-live");

    const enable = runWithState(
      stateFile,
      "plugins",
      "enable",
      destroySessionPlugin,
    );
    assert.equal(enable.status, 0, enable.stderr);

    const second = runWithDaemon(
      stateFile,
      daemonFile,
      "sessions",
      "create",
      instanceId,
      "--port",
      String(echoAddress.port),
    );
    assert.equal(second.status, 0, second.stderr);
    assert.equal(
      await roundTrip(parseEndpoint(second.stdout), "after-enable"),
      "after-enable",
    );
  } finally {
    runWithDaemon(stateFile, daemonFile, "daemon", "stop");
    await new Promise((resolve, reject) =>
      echo.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("instances list returns useful partial inventory with explicit degraded status", async () => {
  const stateFile = join(testDirectory, "partial-inventory-state.json");
  const staleId = "instance:550e8400-e29b-41d4-a716-446655440000";
  await new JsonStateStore(stateFile).write({
    version: 1,
    plugins: [
      { source: partialHealthyPlugin, enabled: true },
      { source: partialFailingPlugin, enabled: true },
    ],
    instances: [
      {
        id: staleId,
        providerId: "partial-failing",
        providerExternalId: "stale-remote",
        observation: {
          state: "stopped",
          name: "Last known GPU",
          observedAt: "2026-08-11T12:00:00.000Z",
        },
      },
    ],
  });

  const result = runWithState(stateFile, "instances", "list");

  assert.equal(result.status, 2);
  assert.match(
    result.stdout,
    /provider=partial-healthy external=healthy-remote management=discovered freshness=fresh state=running actions=instance\.stop/,
  );
  assert.match(
    result.stdout,
    new RegExp(`${staleId} provider=partial-failing external=stale-remote management=discovered freshness=stale state=stopped actions=-`),
  );
  assert.match(
    result.stderr,
    /Provider partial-failing inventory failed \(provider-unavailable\): Provider partial-failing inventory refresh failed/,
  );
  assert.doesNotMatch(result.stderr, /provider-private-payload=must-not-escape/);

  const jsonResult = runWithState(stateFile, "--json", "instances", "list");
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  assert.equal(jsonResult.stderr, "");
  const envelope = JSON.parse(jsonResult.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.inventory.complete, false);
  const fresh = envelope.data.inventory.instances.find(
    (instance) => instance.providerId === "partial-healthy",
  );
  assert.equal(fresh.providerExternalId, "healthy-remote");
  assert.equal(fresh.name, "Healthy GPU");
  assert.equal(fresh.management, "discovered");
  assert.equal(fresh.freshness, "fresh");
  const stale = envelope.data.inventory.instances.find(
    (instance) => instance.providerId === "partial-failing",
  );
  assert.equal(stale.id, staleId);
  assert.equal(stale.providerExternalId, "stale-remote");
  assert.equal(stale.name, "Last known GPU");
  assert.equal(stale.management, "discovered");
  assert.equal(stale.freshness, "stale");
  assert.deepEqual(stale.availableActions, []);
  assert.equal(
    envelope.data.inventory.providers.some(
      (provider) =>
        provider.providerId === "partial-failing" && provider.status === "failed",
    ),
    true,
  );
});

test("instances list reports total inventory failure when no useful state exists", async () => {
  const stateFile = join(testDirectory, "failed-inventory-state.json");
  await new JsonStateStore(stateFile).write({
    version: 1,
    plugins: [{ source: partialFailingPlugin, enabled: true }],
  });

  const result = runWithState(stateFile, "instances", "list");

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "No compute instances found.\n");
  assert.match(result.stderr, /Provider partial-failing inventory failed/);
});

test("escapes provider-controlled terminal text without mutating provider identity", () => {
  const stateFile = join(testDirectory, "terminal-output-state.json");
  assert.equal(
    runWithState(stateFile, "plugins", "add", terminalOutputPlugin).status,
    0,
  );

  const inventory = runWithState(stateFile, "instances", "list");
  assert.equal(inventory.status, 0);
  assert.ok(
    inventory.stdout.includes("external=remote\\nforged\\r\\u001b[31m"),
  );
  assert.equal(inventory.stdout.includes(unsafeProviderExternalId), false);
  assert.equal(inventory.stdout.includes("\u001b"), false);
  const [instanceId] = inventory.stdout.match(/instance:[0-9a-f-]+/i) ?? [];
  assert.ok(instanceId);

  const inspect = runWithState(stateFile, "instances", "inspect", instanceId);
  assert.equal(inspect.status, 0);
  assert.equal(
    JSON.parse(inspect.stdout).providerExternalId,
    unsafeProviderExternalId,
  );

  const features = runWithState(stateFile, "provider");
  assert.equal(features.status, 0);
  assert.ok(features.stdout.includes("Unsafe\\nFeature\\u001b[2J"));
  assert.equal(features.stdout.includes(unsafeFeatureDisplayName), false);

  const commands = runWithState(
    stateFile,
    "provider",
    "terminal-output",
    "marketplace",
  );
  assert.equal(commands.status, 0);
  assert.ok(commands.stdout.includes("Unsafe\\rDescription\\u001b[31m"));
  assert.equal(commands.stdout.includes(unsafeCommandDescription), false);
});

test("mounts provider feature commands and reconciles requested inventory changes", async () => {
  const stateFile = join(testDirectory, "provider-cli-state.json");
  assert.equal(
    runWithState(stateFile, "plugins", "add", providerCliPlugin).status,
    0,
  );

  const features = runWithState(stateFile, "provider");
  assert.equal(features.status, 0);
  assert.match(features.stdout, /provider-cli\/marketplace Fixture Marketplace/);

  const commands = runWithState(
    stateFile,
    "provider",
    "provider-cli",
    "marketplace",
  );
  assert.equal(commands.status, 0);
  assert.match(commands.stdout, /echo\s+Echo provider-owned arguments/);

  const legacyHelp = runWithState(
    stateFile,
    "provider",
    "provider-cli",
    "marketplace",
    "echo",
    "--help",
  );
  assert.equal(legacyHelp.status, 0);
  assert.match(legacyHelp.stdout, /Provider-specific help is unavailable for provider-cli/);
  assert.match(legacyHelp.stdout, /did not import the normal Provider Plugin entrypoint/);
  assert.match(legacyHelp.stdout, /dedicated side-effect-free \.\/easyserver-help contribution/);
  assert.doesNotMatch(legacyHelp.stdout, /provider-owned:/);

  const mutationHelp = runWithState(
    stateFile,
    "provider",
    "provider-cli",
    "marketplace",
    "create",
    "--help",
  );
  assert.equal(mutationHelp.status, 0);
  assert.match(mutationHelp.stdout, /Provider-specific help is unavailable for provider-cli/);
  const stateAfterHelp = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(stateAfterHelp.instances, undefined);

  const execute = runWithState(
    stateFile,
    "provider",
    "provider-cli",
    "marketplace",
    "echo",
    "alpha",
    "beta",
  );
  assert.equal(execute.status, 0);
  assert.equal(execute.stdout, "provider-owned:alpha|beta\n");

  const blockedCreate = runWithState(
    stateFile,
    "provider",
    "provider-cli",
    "marketplace",
    "create",
    "fixture-name",
  );
  assert.equal(blockedCreate.status, 1);
  assert.match(blockedCreate.stderr, /requires explicit --yes because it is billable/);
  assert.equal(
    JSON.parse(await readFile(stateFile, "utf8")).instances,
    undefined,
  );

  const create = runWithState(
    stateFile,
    "provider",
    "provider-cli",
    "marketplace",
    "create",
    "--yes",
    "fixture-name",
  );
  assert.equal(create.status, 0);
  const createLines = create.stdout.trim().split("\n");
  assert.equal(createLines[0], "created:created-1");
  const canonical = createLines[1].match(
    /^EasyServer instance (instance:[0-9a-f-]+) provider=provider-cli external=created-1$/,
  );
  assert.ok(canonical);
  const reconciledState = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(reconciledState.instances.length, 1);
  assert.equal(reconciledState.instances[0].id, canonical[1]);
  assert.equal(reconciledState.instances[0].providerId, "provider-cli");
  assert.equal(reconciledState.instances[0].providerExternalId, "created-1");
  assert.equal(reconciledState.instances[0].management, "managed");

  assert.equal(
    runWithState(stateFile, "plugins", "disable", providerCliPlugin).status,
    0,
  );
  const removed = runWithState(
    stateFile,
    "provider",
    "provider-cli",
    "marketplace",
    "echo",
  );
  assert.equal(removed.status, 1);
  assert.match(removed.stderr, /Provider Feature not found/);
});

test("confirmed provider mutation stays successful when handoff refresh fails and later observation does not redispatch", async () => {
  const stateFile = join(testDirectory, "provider-cli-handoff-failure-state.json");
  const pluginPath = join(testDirectory, "provider-cli-handoff-failure-plugin.mjs");
  const mutationCountPath = join(testDirectory, "provider-cli-handoff-mutation-count.txt");
  const failedRefreshPath = join(testDirectory, "provider-cli-handoff-refresh-failed.txt");
  await writeFile(
    pluginPath,
    `import { existsSync, readFileSync, writeFileSync } from "node:fs";

const mutationCountPath = ${JSON.stringify(mutationCountPath)};
const failedRefreshPath = ${JSON.stringify(failedRefreshPath)};

function snapshot() {
  return {
    providerExternalId: "created-1",
    state: "running",
    rawState: "READY",
    availableActions: [],
  };
}

export default {
  manifest: {
    id: "fixture.handoff-failure",
    displayName: "Handoff Failure Fixture",
    version: "1.0.0",
    compatibility: { easyserver: "^0.2.0", pluginSdk: "^0.2.0" },
    provider: {
      id: "handoff-failure",
      displayName: "Handoff Failure Provider",
      capabilities: [],
    },
  },
  provider: {
    providerId: "handoff-failure",
    async listInstances() {
      if (!existsSync(mutationCountPath)) {
        return [];
      }
      if (!existsSync(failedRefreshPath)) {
        writeFileSync(failedRefreshPath, "failed", "utf8");
        throw new Error("fixture refresh failure");
      }
      return [snapshot()];
    },
    async getInstance(providerExternalId) {
      return existsSync(mutationCountPath) && providerExternalId === "created-1"
        ? snapshot()
        : undefined;
    },
  },
  features: [{
    id: "marketplace",
    displayName: "Marketplace",
    cli: {
      commands: [{
        name: "create",
        description: "Create once",
        operation: "mutation",
        async run(_args, context) {
          context.markMutationDispatched();
          const previous = existsSync(mutationCountPath)
            ? Number(readFileSync(mutationCountPath, "utf8"))
            : 0;
          writeFileSync(mutationCountPath, String(previous + 1), "utf8");
          context.write("created:created-1\\n");
          return {
            refreshProviderInventory: true,
            affectedProviderExternalIds: ["created-1"],
          };
        },
      }],
    },
  }],
};
`,
    "utf8",
  );

  assert.equal(
    runWithState(stateFile, "plugins", "add", pluginPath).status,
    0,
  );

  const create = runWithState(
    stateFile,
    "provider",
    "handoff-failure",
    "marketplace",
    "create",
  );

  assert.equal(create.status, 0, create.stderr);
  assert.equal(create.stdout, "created:created-1\n");
  assert.match(create.stderr, /Mutation succeeded/);
  assert.match(create.stderr, /follow-up provider inventory refresh failed/);
  assert.match(create.stderr, /Do not repeat handoff-failure\/marketplace\/create/);
  assert.match(create.stderr, /easyserver instances list/);
  assert.doesNotMatch(create.stderr, /outcome-unknown/);
  assert.equal(await readFile(mutationCountPath, "utf8"), "1");
  const afterFailedHandoff = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(afterFailedHandoff.instances?.length ?? 0, 0);
  assert.deepEqual(afterFailedHandoff.pendingManagedResources, [
    { providerId: "handoff-failure", providerExternalId: "created-1" },
  ]);

  const observed = runWithState(stateFile, "instances", "list");
  assert.equal(observed.status, 0, observed.stderr);
  assert.match(
    observed.stdout,
    /^instance:[0-9a-f-]+ provider=handoff-failure external=created-1 management=managed freshness=fresh state=running actions=-/m,
  );
  assert.equal(await readFile(mutationCountPath, "utf8"), "1");
  const reconciled = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(reconciled.instances[0].management, "managed");
  assert.equal(reconciled.pendingManagedResources, undefined);
});

test("provider feature outcome-unknown reconciles inventory without retrying the mutation", async () => {
  const stateFile = join(testDirectory, "provider-cli-outcome-unknown-state.json");
  assert.equal(
    runWithState(stateFile, "plugins", "add", providerCliPlugin).status,
    0,
  );

  const result = runWithState(
    stateFile,
    "provider",
    "provider-cli",
    "marketplace",
    "uncertain-create",
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /outcome-unknown: fixture mutation outcome is unknown/);
  assert.doesNotMatch(result.stderr, /Usage:/);
  const reconciledState = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(reconciledState.instances.length, 1);
  assert.equal(reconciledState.instances[0].providerId, "provider-cli");
  assert.equal(reconciledState.instances[0].providerExternalId, "created-1");
});

test("concurrent managed daemon starts cannot delete a fresh successor descriptor", async () => {
  const stateFile = join(testDirectory, "managed-daemon-concurrent-state.json");
  const daemonFile = join(testDirectory, "managed-daemon-concurrent-control.json");
  await writeFile(
    stateFile,
    `${JSON.stringify({ version: 1, plugins: [] })}\n`,
    "utf8",
  );
  const stalePort = await findFreePort();
  await writeFile(
    daemonFile,
    `${JSON.stringify({
      version: 1,
      address: { host: "127.0.0.1", port: stalePort },
      authToken: "stale-concurrent-token",
    })}\n`,
    "utf8",
  );

  try {
    const first = startWithDaemon(stateFile, daemonFile, {}, "daemon", "start");
    const second = startWithDaemon(stateFile, daemonFile, {}, "daemon", "start");
    const [firstResult, secondResult] = await Promise.all([
      finishCommand(first),
      finishCommand(second),
    ]);

    assert.equal(firstResult.status, 0, firstResult.stderr);
    assert.equal(secondResult.status, 0, secondResult.stderr);
    const running = runWithDaemon(stateFile, daemonFile, "daemon", "status");
    assert.equal(running.status, 0, running.stderr);
    assert.match(running.stdout, /^running endpoint=127\.0\.0\.1:\d+$/m);

    const stop = runWithDaemon(stateFile, daemonFile, "daemon", "stop");
    assert.equal(stop.status, 0, stop.stderr);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const stayedStopped = runWithDaemon(
      stateFile,
      daemonFile,
      "daemon",
      "status",
    );
    assert.equal(stayedStopped.status, 1, stayedStopped.stderr);
    assert.equal(stayedStopped.stdout, "stopped\n");
  } finally {
    runWithDaemon(stateFile, daemonFile, "daemon", "stop");
  }
});

test("managed daemon startup timeout terminates its detached child", async () => {
  const stateFile = join(testDirectory, "managed-daemon-timeout-state.json");
  const daemonFile = join(testDirectory, "managed-daemon-timeout-control.json");
  const pluginPath = join(testDirectory, "managed-daemon-timeout-plugin.mjs");
  const startedPath = join(testDirectory, "managed-daemon-timeout-started.txt");
  const releasePath = join(testDirectory, "managed-daemon-timeout-release.txt");
  await writeDelayedPlugin(
    pluginPath,
    startedPath,
    releasePath,
    "managed-daemon-timeout",
  );
  await writeFile(
    stateFile,
    `${JSON.stringify({
      version: 1,
      plugins: [{ source: pluginPath, enabled: true }],
      instances: [
        {
          id: "instance:550e8400-e29b-41d4-a716-446655440000",
          providerId: "managed-daemon-timeout",
          providerExternalId: "remote-1",
        },
      ],
      endpointIntents: [
        {
          name: "startup-blocker",
          enabled: true,
          instanceId: "instance:550e8400-e29b-41d4-a716-446655440000",
          remoteHost: "127.0.0.1",
          remotePort: 8188,
        },
      ],
    })}\n`,
    "utf8",
  );

  try {
    const start = runWithDaemonEnv(
      stateFile,
      daemonFile,
      { EASYSERVER_DAEMON_START_TIMEOUT_MS: "2000" },
      "daemon",
      "start",
    );
    assert.equal(start.status, 1);
    assert.match(start.stderr, /Timed out waiting for EasyServer daemon startup/);
    await waitForFile(startedPath);

    await writeFile(releasePath, "release", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const status = runWithDaemon(stateFile, daemonFile, "daemon", "status");
    assert.equal(status.status, 1, status.stderr);
    assert.equal(status.stdout, "stopped\n");
  } finally {
    await writeFile(releasePath, "release", "utf8").catch(() => undefined);
    runWithDaemon(stateFile, daemonFile, "daemon", "stop");
  }
});

test("managed daemon lifecycle recovers stale descriptors and gracefully closes live sessions", async () => {
  const stateFile = join(testDirectory, "managed-daemon-state.json");
  const daemonFile = join(testDirectory, "managed-daemon-control.json");
  const instanceId = "instance:550e8400-e29b-41d4-a716-446655440000";
  await writeFile(
    stateFile,
    `${JSON.stringify({
      version: 1,
      plugins: [{ source: daemonPlugin, enabled: true }],
      instances: [
        {
          id: instanceId,
          providerId: "daemon-fixture",
          providerExternalId: "remote-1",
        },
      ],
    })}\n`,
    "utf8",
  );

  const stalePort = await findFreePort();
  await writeFile(
    daemonFile,
    `${JSON.stringify({
      version: 1,
      address: { host: "127.0.0.1", port: stalePort },
      authToken: "stale-token",
    })}\n`,
    "utf8",
  );

  const stale = runWithDaemon(stateFile, daemonFile, "daemon", "status");
  assert.equal(stale.status, 2, stale.stderr);
  assert.match(stale.stdout, /^stale reason=authenticated health check failed$/m);

  const echo = createServer((socket) => socket.pipe(socket));
  echo.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  await once(echo, "listening");
  const echoAddress = echo.address();
  assert.ok(echoAddress && typeof echoAddress !== "string");

  try {
    const start = runWithDaemon(stateFile, daemonFile, "daemon", "start");
    assert.equal(start.status, 0, start.stderr);
    assert.match(start.stdout, /EasyServer daemon started on 127\.0\.0\.1:\d+/);

    const running = runWithDaemon(stateFile, daemonFile, "daemon", "status");
    assert.equal(running.status, 0, running.stderr);
    assert.match(running.stdout, /^running endpoint=127\.0\.0\.1:\d+$/m);

    const repeatedStart = runWithDaemon(
      stateFile,
      daemonFile,
      "daemon",
      "start",
    );
    assert.equal(repeatedStart.status, 0, repeatedStart.stderr);
    assert.match(repeatedStart.stdout, /already running/);

    const create = runWithDaemon(
      stateFile,
      daemonFile,
      "sessions",
      "create",
      instanceId,
      "--port",
      String(echoAddress.port),
    );
    assert.equal(create.status, 0, create.stderr);
    const endpointMatch = create.stdout.match(/endpoint=(127\.0\.0\.1):(\d+)/);
    assert.ok(endpointMatch, create.stdout);
    const endpoint = { host: endpointMatch[1], port: Number(endpointMatch[2]) };
    assert.equal(await roundTrip(endpoint, "managed-daemon"), "managed-daemon");

    const stop = runWithDaemon(stateFile, daemonFile, "daemon", "stop");
    assert.equal(stop.status, 0, stop.stderr);
    assert.match(
      stop.stdout,
      /Stopping EasyServer daemon; closing live-sessions=1 active-endpoint-intents=0\./,
    );
    assert.match(stop.stdout, /EasyServer daemon stopped\./);
    await waitForConnectionRefused(endpoint);

    const stopped = runWithDaemon(stateFile, daemonFile, "daemon", "status");
    assert.equal(stopped.status, 1, stopped.stderr);
    assert.equal(stopped.stdout, "stopped\n");

    const repeatedStop = runWithDaemon(
      stateFile,
      daemonFile,
      "daemon",
      "stop",
    );
    assert.equal(repeatedStop.status, 0, repeatedStop.stderr);
    assert.equal(repeatedStop.stdout, "EasyServer daemon already stopped.\n");
  } finally {
    runWithDaemon(stateFile, daemonFile, "daemon", "stop");
    await new Promise((resolve, reject) =>
      echo.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("daemon-owned sessions survive the creating CLI and restart without phantom sessions", async () => {
  const stateFile = join(testDirectory, "daemon-state.json");
  const daemonFile = join(testDirectory, "daemon-control.json");
  const instanceId = "instance:550e8400-e29b-41d4-a716-446655440000";
  await writeFile(
    stateFile,
    `${JSON.stringify({
      version: 1,
      plugins: [{ source: daemonPlugin, enabled: true }],
      instances: [
        {
          id: instanceId,
          providerId: "daemon-fixture",
          providerExternalId: "remote-1",
        },
      ],
    })}\n`,
    "utf8",
  );

  const methods = runWithState(
    stateFile,
    "instances",
    "access-methods",
    instanceId,
  );
  assert.equal(methods.status, 0, methods.stderr);
  assert.equal(
    methods.stdout,
    "fixture-loopback kind=daemon-fixture:loopback mode=tcp-forward\n",
  );

  const echo = createServer((socket) => {
    socket.on("error", (error) => {
      // The daemon is intentionally killed below; Windows can report that
      // expected peer teardown as ECONNRESET on the remote fixture socket.
      if (error?.code !== "ECONNRESET") {
        throw error;
      }
    });
    socket.pipe(socket);
  });
  echo.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  await once(echo, "listening");
  const echoAddress = echo.address();
  assert.ok(echoAddress && typeof echoAddress !== "string");

  let daemon = startDaemon(stateFile, daemonFile);
  try {
    const firstDescriptor = await waitForDaemonFile(daemonFile, daemon);
    assert.doesNotMatch(
      await readFile(stateFile, "utf8"),
      new RegExp(firstDescriptor.authToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );

    const requestedLocalPort = await findFreePort();
    const create = runWithDaemon(
      stateFile,
      daemonFile,
      "sessions",
      "create",
      instanceId,
      "--port",
      String(echoAddress.port),
      "--local-port",
      String(requestedLocalPort),
      "--access-method",
      "fixture-loopback",
      "--idempotency-key",
      "cli-retry",
    );
    assert.equal(create.status, 0, create.stderr);
    const match = create.stdout.match(
      /^(\S+) idempotency-key=cli-retry requested-local-port=(\d+) endpoint=(127\.0\.0\.1):(\d+) access-method=fixture-loopback kind=daemon-fixture:loopback$/m,
    );
    assert.ok(match, create.stdout);
    const [, sessionId, requestedPortText, host, portText] = match;
    assert.equal(Number(requestedPortText), requestedLocalPort);
    assert.equal(Number(portText), requestedLocalPort);
    const endpoint = { host, port: Number(portText) };

    const retry = runWithDaemon(
      stateFile,
      daemonFile,
      "sessions",
      "create",
      instanceId,
      "--port",
      String(echoAddress.port),
      "--local-port",
      String(requestedLocalPort),
      "--access-method",
      "fixture-loopback",
      "--idempotency-key",
      "cli-retry",
    );
    assert.equal(retry.status, 0, retry.stderr);
    assert.match(
      retry.stdout,
      new RegExp(`^${sessionId} idempotency-key=cli-retry requested-local-port=${requestedLocalPort} endpoint=127\\.0\\.0\\.1:${requestedLocalPort} access-method=fixture-loopback kind=daemon-fixture:loopback$`, "m"),
    );

    assert.equal(await roundTrip(endpoint, "after-cli-exit"), "after-cli-exit");

    const list = runWithDaemon(stateFile, daemonFile, "sessions", "list");
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, new RegExp(sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(list.stdout, /idempotency-key=cli-retry/);
    assert.match(list.stdout, new RegExp(`requested-local-port=${requestedLocalPort}`));
    assert.match(
      list.stdout,
      /access-method=fixture-loopback kind=daemon-fixture:loopback/,
    );

    const close = runWithDaemon(
      stateFile,
      daemonFile,
      "sessions",
      "close",
      sessionId,
    );
    assert.equal(close.status, 0, close.stderr);
    await waitForConnectionRefused(endpoint);

    const intentLocalPort = await findFreePort();
    const createIntent = runWithDaemon(
      stateFile,
      daemonFile,
      "sessions",
      "intents",
      "create",
      "persisted-main",
      instanceId,
      "--port",
      String(echoAddress.port),
      "--local-port",
      String(intentLocalPort),
      "--access-method",
      "fixture-loopback",
    );
    assert.equal(createIntent.status, 0, createIntent.stderr);
    assert.match(createIntent.stdout, /persisted-main state=starting enabled=true/);

    let intentList;
    const intentDeadline = Date.now() + 3000;
    while (Date.now() < intentDeadline) {
      intentList = runWithDaemon(
        stateFile,
        daemonFile,
        "sessions",
        "intents",
        "list",
      );
      if (intentList.stdout.includes("persisted-main state=live")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(intentList?.status, 0, intentList?.stderr);
    assert.match(
      intentList?.stdout ?? "",
      new RegExp(`persisted-main state=live.*endpoint=127\\.0\\.0\\.1:${intentLocalPort}.*access-method=fixture-loopback`),
    );
    const intentEndpoint = { host: "127.0.0.1", port: intentLocalPort };
    assert.equal(await roundTrip(intentEndpoint, "intent-before-restart"), "intent-before-restart");

    const second = runWithDaemon(
      stateFile,
      daemonFile,
      "sessions",
      "create",
      instanceId,
      "--port",
      String(echoAddress.port),
    );
    assert.equal(second.status, 0, second.stderr);
    const secondMatch = second.stdout.match(
      /requested-local-port=dynamic endpoint=(127\.0\.0\.1):(\d+) access-method=fixture-loopback kind=daemon-fixture:loopback/,
    );
    assert.ok(secondMatch, second.stdout);
    const secondEndpoint = {
      host: secondMatch[1],
      port: Number(secondMatch[2]),
    };
    assert.equal(await roundTrip(secondEndpoint, "before-restart"), "before-restart");

    daemon.child.kill();
    await once(daemon.child, "exit");
    await waitForConnectionRefused(secondEndpoint);
    await waitForConnectionRefused(intentEndpoint);

    daemon = startDaemon(stateFile, daemonFile);
    await waitForDaemonFile(
      daemonFile,
      daemon,
      5000,
      firstDescriptor.authToken,
    );
    const afterRestart = runWithDaemon(
      stateFile,
      daemonFile,
      "sessions",
      "list",
    );
    assert.equal(afterRestart.status, 0, afterRestart.stderr);
    assert.equal(afterRestart.stdout, "No connection sessions found.\n");

    let restoredIntent;
    const restoreDeadline = Date.now() + 3000;
    while (Date.now() < restoreDeadline) {
      restoredIntent = runWithDaemon(
        stateFile,
        daemonFile,
        "sessions",
        "intents",
        "list",
      );
      if (restoredIntent.stdout.includes("persisted-main state=live")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(restoredIntent?.status, 0, restoredIntent?.stderr);
    assert.match(
      restoredIntent?.stdout ?? "",
      new RegExp(`persisted-main state=live.*endpoint=127\\.0\\.0\\.1:${intentLocalPort}`),
    );
    assert.equal(await roundTrip(intentEndpoint, "intent-after-restart"), "intent-after-restart");
  } finally {
    if (daemon.child.exitCode === null) {
      daemon.child.kill();
      await once(daemon.child, "exit");
    }
    await new Promise((resolve, reject) =>
      echo.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("rejects malformed plugin list arguments", () => {
  const result = run("plugins", "list", "--plugin");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /accepts only --plugin <module> pairs/);
});

test("operational runtime errors do not append global help", () => {
  const result = runWithDaemon(
    emptyStateFile,
    join(testDirectory, "missing-daemon.json"),
    "sessions",
    "list",
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EasyServer daemon is not running/);
  assert.doesNotMatch(result.stderr, /Usage:/);
});

test("connect validates its target before opening providers", () => {
  const missingPort = run("connect", "instance:test");
  assert.equal(missingPort.status, 1);
  assert.match(missingPort.stderr, /connect requires --port/);
  assert.match(missingPort.stderr, /See: easyserver connect --help/);
  assert.doesNotMatch(missingPort.stderr, /Usage:/);

  const invalidPort = run("connect", "instance:test", "--port", "70000");
  assert.equal(invalidPort.status, 1);
  assert.match(invalidPort.stderr, /between 1 and 65535/);
});

test("rejects unknown commands", () => {
  const result = run("nope");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: nope/);
  assert.match(result.stderr, /See: easyserver --help/);
  assert.doesNotMatch(result.stderr, /Usage:/);
});
