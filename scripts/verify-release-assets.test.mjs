import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  expectedReleaseAssetNames,
  verifyPublishedAssetNames,
  verifyReleaseAssets,
  writeReleaseChecksums,
} from "./verify-release-assets.mjs";
import { RELEASE_TARGETS, releaseAssetName } from "./release-targets.mjs";

const version = "9.8.7";

test("complete portable asset matrix produces and verifies one checksum manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "easyserver-release-assets-test-"));
  try {
    for (const target of RELEASE_TARGETS) {
      await writeFile(join(directory, releaseAssetName(version, target)), `artifact:${target.id}`, "utf8");
    }
    const checksumPath = await writeReleaseChecksums(directory, version);
    const checksum = await readFile(checksumPath, "utf8");
    assert.equal(checksum.trim().split(/\r?\n/u).length, RELEASE_TARGETS.length);
    await verifyReleaseAssets(directory, version);
    verifyPublishedAssetNames(expectedReleaseAssetNames(version), version);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing qualified platform artifact fails before release publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "easyserver-release-assets-missing-"));
  try {
    for (const target of RELEASE_TARGETS.slice(0, -1)) {
      await writeFile(join(directory, releaseAssetName(version, target)), `artifact:${target.id}`, "utf8");
    }
    await assert.rejects(() => writeReleaseChecksums(directory, version), /missing release artifact/u);
    assert.throws(
      () => verifyPublishedAssetNames(expectedReleaseAssetNames(version).slice(0, -1), version),
      /published GitHub Release assets must match/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
