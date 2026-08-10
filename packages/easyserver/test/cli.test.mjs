import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const validPlugin = fileURLToPath(
  new URL("./fixtures/valid-plugin.mjs", import.meta.url),
);
const brokenPlugin = fileURLToPath(
  new URL("./fixtures/broken-plugin.mjs", import.meta.url),
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
const intelionPlugin = fileURLToPath(
  new URL("../../../plugins/intelion/dist/index.js", import.meta.url),
);
const providerCollisionPlugin = `data:text/javascript,${encodeURIComponent(`
  export default {
    manifest: {
      id: "fixture.collision",
      displayName: "Provider Collision Fixture",
      version: "1.0.0",
      compatibility: { easyserver: "^0.1.0", pluginSdk: "^0.1.0" },
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
const testDirectory = await mkdtemp(join(tmpdir(), "easyserver-cli-"));
const emptyStateFile = join(testDirectory, "empty-state.json");

after(async () => {
  await rm(testDirectory, { recursive: true, force: true });
});

function run(...args) {
  return runWithState(emptyStateFile, ...args);
}

function runWithState(stateFile, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, EASYSERVER_STATE_FILE: stateFile },
  });
}

function runWithDaemon(stateFile, daemonFile, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      EASYSERVER_STATE_FILE: stateFile,
      EASYSERVER_DAEMON_FILE: daemonFile,
    },
  });
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

test("prints help", () => {
  const result = run("--help");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /EasyServer/);
  assert.match(result.stdout, /--version/);
  assert.match(result.stdout, /connect <instance-id> --port <remote-port>/);
});

test("prints version", () => {
  const result = run("--version");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "0.1.0\n");
});

test("published CLI entrypoint is directly executable by Node-compatible shells", async () => {
  assert.match(await readFile(cli, "utf8"), /^#!\/usr\/bin\/env node\r?\n/);
});

test("loads first-party workspace packages as explicit provider plugins", () => {
  for (const [source, providerId] of [
    ["@easyai101/easyserver-plugin-vastai", "vastai"],
    [intelionPlugin, "intelion"],
  ]) {
    const result = run("plugins", "list", "--plugin", source);
    assert.equal(result.status, 0);
    assert.match(
      result.stdout,
      new RegExp(`^loaded\\s+${providerId} provider=${providerId}$`, "m"),
    );
  }
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
  assert.match(firstList.stdout, /provider=inventory external=remote-1 state=running/);
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
    state: "running",
    rawState: "READY",
    availableActions: ["instance.stop"],
    name: "Fixture GPU",
  });

  const stop = runWithState(stateFile, "instances", "stop", instanceId);
  assert.equal(stop.status, 0);
  assert.equal(stop.stdout, `Requested instance.stop for ${instanceId}\n`);

  const start = runWithState(stateFile, "instances", "start", instanceId);
  assert.equal(start.status, 1);
  assert.match(start.stderr, /conflict: instance\.start is not available/);
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

  const create = runWithState(
    stateFile,
    "provider",
    "provider-cli",
    "marketplace",
    "create",
  );
  assert.equal(create.status, 0);
  assert.equal(create.stdout, "created:created-1\n");
  const reconciledState = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(reconciledState.instances.length, 1);
  assert.equal(reconciledState.instances[0].providerId, "provider-cli");
  assert.equal(reconciledState.instances[0].providerExternalId, "created-1");

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

  const echo = createServer((socket) => socket.pipe(socket));
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
    const match = create.stdout.match(
      /^(\S+) endpoint=(127\.0\.0\.1):(\d+)$/m,
    );
    assert.ok(match, create.stdout);
    const [, sessionId, host, portText] = match;
    const endpoint = { host, port: Number(portText) };

    assert.equal(await roundTrip(endpoint, "after-cli-exit"), "after-cli-exit");

    const list = runWithDaemon(stateFile, daemonFile, "sessions", "list");
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, new RegExp(sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const close = runWithDaemon(
      stateFile,
      daemonFile,
      "sessions",
      "close",
      sessionId,
    );
    assert.equal(close.status, 0, close.stderr);
    await waitForConnectionRefused(endpoint);

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
    const secondMatch = second.stdout.match(/endpoint=(127\.0\.0\.1):(\d+)/);
    assert.ok(secondMatch, second.stdout);
    const secondEndpoint = {
      host: secondMatch[1],
      port: Number(secondMatch[2]),
    };
    assert.equal(await roundTrip(secondEndpoint, "before-restart"), "before-restart");

    daemon.child.kill();
    await once(daemon.child, "exit");
    await waitForConnectionRefused(secondEndpoint);

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
  assert.match(missingPort.stderr, /Usage:/);

  const invalidPort = run("connect", "instance:test", "--port", "70000");
  assert.equal(invalidPort.status, 1);
  assert.match(invalidPort.stderr, /between 1 and 65535/);
});

test("rejects unknown commands", () => {
  const result = run("nope");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: nope/);
  assert.match(result.stderr, /Usage:/);
});
