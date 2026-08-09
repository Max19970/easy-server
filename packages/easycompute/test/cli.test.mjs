import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

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

test("rejects unknown commands", () => {
  const result = run("nope");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: nope/);
});
