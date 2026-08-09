import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const providerCollisionPlugin = `data:text/javascript,${encodeURIComponent(
  `export default ${JSON.stringify({
    manifest: {
      id: "fixture.collision",
      displayName: "Provider Collision Fixture",
      version: "1.0.0",
      compatibility: { easycompute: "0.0.0", pluginSdk: "0.0.0" },
      provider: {
        id: "fixture",
        displayName: "Fixture Provider",
        capabilities: [],
      },
    },
    provider: { providerId: "fixture" },
  })};`,
)}`;
const testDirectory = await mkdtemp(join(tmpdir(), "easycompute-cli-"));
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
    env: { ...process.env, EASYCOMPUTE_STATE_FILE: stateFile },
  });
}

function relativePluginSource(source) {
  const path = relative(process.cwd(), source);
  return process.platform === "win32" ? `.\\${path}` : `./${path}`;
}

test("prints help", () => {
  const result = run("--help");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /EasyCompute/);
  assert.match(result.stdout, /--version/);
});

test("prints version", () => {
  const result = run("--version");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "0.0.0\n");
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

test("rejects malformed plugin list arguments", () => {
  const result = run("plugins", "list", "--plugin");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /accepts only --plugin <module> pairs/);
});

test("rejects unknown commands", () => {
  const result = run("nope");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: nope/);
});
