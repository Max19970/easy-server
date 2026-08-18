import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspacePackagePaths = [
  "packages/easyserver/package.json",
  "packages/plugin-sdk/package.json",
];

async function readPackage(path) {
  return JSON.parse(await readFile(join(root, path), "utf8"));
}

test("workspace-local tests build current source before running compiled tests", async () => {
  const packages = await Promise.all(workspacePackagePaths.map(readPackage));

  for (const packageJson of packages) {
    assert.equal(
      packageJson.scripts.test,
      "npm run build && npm run test:compiled",
      `${packageJson.name} must build before its package-local test suite`,
    );
    assert.equal(
      packageJson.scripts["test:compiled"],
      "node --test test/*.test.mjs",
      `${packageJson.name} must keep compiled-output tests behind the guarded entry point`,
    );
  }
});

test("in-repo SDK consumers rebuild the SDK before compiling their own tests", async () => {
  const sdkConsumers = await Promise.all([
    readPackage("packages/easyserver/package.json"),
  ]);

  for (const packageJson of sdkConsumers) {
    assert.equal(
      packageJson.scripts.prebuild,
      "npm run build --workspace=@easyai101/easyserver-plugin-sdk",
      `${packageJson.name} must compile against the current SDK build`,
    );
  }
});

test("root test builds once before invoking compiled-only workspace suites", async () => {
  const packageJson = await readPackage("package.json");
  assert.equal(
    packageJson.scripts.test,
    "npm run build && npm run test:compiled --workspaces --if-present && node --test scripts/*.test.mjs",
  );
});
