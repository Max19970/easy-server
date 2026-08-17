import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  RELEASE_TARGETS,
  githubMatrix,
  validateReleaseTargets,
} from "./release-targets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
test("release target contract covers the qualified matrix exactly once", () => {
  validateReleaseTargets();
  assert.deepEqual(
    RELEASE_TARGETS.map(({ id, platform, arch }) => ({ id, platform, arch })),
    [
      { id: "windows-x64", platform: "win32", arch: "x64" },
      { id: "linux-x64", platform: "linux", arch: "x64" },
      { id: "macos-arm64", platform: "darwin", arch: "arm64" },
    ],
  );
  assert.equal(githubMatrix().include.length, RELEASE_TARGETS.length);
});

test("release target contract rejects a qualified target without an artifact format", () => {
  assert.throws(
    () =>
      validateReleaseTargets([
        {
          id: "linux-x64",
          name: "Ubuntu",
          runner: "ubuntu-24.04",
          platform: "linux",
          arch: "x64",
        },
      ]),
    /supported archive format/u,
  );
});

test("CI and tag publication derive their matrix from the release target contract", async () => {
  const workflows = await Promise.all([
    readFile(join(root, ".github", "workflows", "ci.yml"), "utf8"),
    readFile(join(root, ".github", "workflows", "release.yml"), "utf8"),
  ]);
  for (const workflow of workflows) {
    assert.equal(
      workflow.includes("node scripts/release-targets.mjs --github-matrix"),
      true,
      "workflow must resolve the authoritative release target matrix",
    );
    assert.equal(
      workflow.includes("fromJSON(needs.release-targets.outputs.matrix)"),
      true,
      "workflow matrix must come from the release target resolver",
    );
  }
  assert.equal(
    workflows[1].includes("node scripts/verify-release-assets.mjs --write-checksums dist/release"),
    true,
    "release publication must verify the complete downloaded asset set",
  );
  assert.equal(
    workflows[1].includes("node scripts/verify-release-assets.mjs --published-names"),
    true,
    "release publication must verify the final GitHub asset names",
  );
  assert.equal(
    workflows[1].includes("needs: [release-targets, publish-release]"),
    true,
    "post-publication smoke must wait for the public GitHub Release",
  );
  assert.equal(
    workflows[1].includes("node scripts/verify-published-release.mjs published-release"),
    true,
    "every native target must smoke the downloaded public artifact",
  );
});

test("current EN and RU release docs enumerate every portable asset", async () => {
  const docs = await Promise.all([
    readFile(join(root, "docs", "github-release-install.md"), "utf8"),
    readFile(join(root, "docs", "ru", "github-release-install.md"), "utf8"),
    readFile(join(root, "docs", "supported-platforms.md"), "utf8"),
    readFile(join(root, "docs", "ru", "supported-platforms.md"), "utf8"),
  ]);
  for (const target of RELEASE_TARGETS) {
    const artifactSuffix = `${target.id}${target.archiveExtension}`;
    for (const document of docs) {
      assert.equal(
        document.includes(artifactSuffix),
        true,
        `${artifactSuffix} must appear in current release docs`,
      );
    }
  }
});
