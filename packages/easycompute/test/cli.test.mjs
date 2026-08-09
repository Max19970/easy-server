import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const validPlugin = fileURLToPath(
  new URL("./fixtures/valid-plugin.mjs", import.meta.url),
);
const brokenPlugin = fileURLToPath(
  new URL("./fixtures/broken-plugin.mjs", import.meta.url),
);

function run(...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
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
