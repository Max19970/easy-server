import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
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
const intelionPlugin = fileURLToPath(
  new URL("../../../plugins/intelion/dist/index.js", import.meta.url),
);
const partialHealthyPlugin = `data:text/javascript,${encodeURIComponent(`
  export default {
    manifest: {
      id: "fixture.partial-healthy",
      displayName: "Partial Healthy Fixture",
      version: "1.0.0",
      compatibility: { easyserver: "^0.1.0", pluginSdk: "^0.1.0" },
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
      compatibility: { easyserver: "^0.1.0", pluginSdk: "^0.1.0" },
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
      compatibility: { easyserver: "^0.2.0", pluginSdk: "^0.1.0" },
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
      compatibility: { easyserver: "^0.1.0", pluginSdk: "^0.1.0" },
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
    compatibility: { easyserver: "^0.1.0", pluginSdk: "^0.1.0" },
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
  assert.equal(report.easyserver.version, "0.1.0");
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
    runWithState(stateFile, "plugins", "add", intelionPlugin).status,
    0,
  );

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
  assert.match(list.stdout, /^failed\s+data:text\/javascript,.*requires EasyServer \^0\.2\.0/m);
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
    compatibility: { easyserver: "^0.1.0", pluginSdk: "^0.1.0" },
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
  assert.match(legacyHelp.stdout, /Echo provider-owned arguments/);
  assert.match(legacyHelp.stdout, /\[provider-args\.\.\.\]/);
  assert.match(legacyHelp.stdout, /does not declare structured argument help/);
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
  assert.match(mutationHelp.stdout, /^Create a provider-owned resource$/m);
  assert.match(mutationHelp.stdout, /^Operation: mutation$/m);
  assert.match(
    mutationHelp.stdout,
    /Usage:\n  easyserver provider provider-cli marketplace create \[--yes\] <resource-name> \[--tag <value>\.\.\.\]/,
  );
  assert.match(
    mutationHelp.stdout,
    /<resource-name> \(required\) Provider-owned resource name/,
  );
  assert.match(
    mutationHelp.stdout,
    /--tag <value> \(optional, repeatable\) Provider-owned tag/,
  );
  assert.match(
    mutationHelp.stdout,
    /easyserver provider provider-cli marketplace create gpu-box --tag team --tag demo/,
  );
  assert.match(mutationHelp.stdout, /Risks: billable/);
  assert.match(mutationHelp.stdout, /non-interactive calls require --yes/);
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
    compatibility: { easyserver: "^0.1.0", pluginSdk: "^0.1.0" },
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
