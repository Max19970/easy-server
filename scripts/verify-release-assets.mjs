import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_TARGETS,
  releaseAssetName,
  releaseChecksumName,
  validateReleaseTargets,
} from "./release-targets.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function expectedReleaseAssetNames(version) {
  validateReleaseTargets();
  return [
    ...RELEASE_TARGETS.map((target) => releaseAssetName(version, target)),
    releaseChecksumName(version),
  ];
}

export async function writeReleaseChecksums(directory, version) {
  validateReleaseTargets();
  const lines = [];
  for (const target of RELEASE_TARGETS) {
    const filename = releaseAssetName(version, target);
    const path = join(directory, filename);
    assert.equal(existsSync(path), true, `missing release artifact: ${filename}`);
    lines.push(`${sha256(await readFile(path))}  ${filename}`);
  }
  const checksumPath = join(directory, releaseChecksumName(version));
  await writeFile(checksumPath, `${lines.join("\n")}\n`, "utf8");
  return checksumPath;
}

export async function verifyReleaseAssets(directory, version) {
  validateReleaseTargets();
  const checksumName = releaseChecksumName(version);
  const checksumPath = join(directory, checksumName);
  assert.equal(existsSync(checksumPath), true, `missing release checksum manifest: ${checksumName}`);

  const manifest = parseChecksumManifest(await readFile(checksumPath, "utf8"));
  const expectedArchives = RELEASE_TARGETS.map((target) => releaseAssetName(version, target));
  assert.deepEqual(
    [...manifest.keys()].sort(),
    [...expectedArchives].sort(),
    "checksum manifest must cover every portable release artifact exactly once",
  );

  for (const filename of expectedArchives) {
    const path = join(directory, filename);
    assert.equal(existsSync(path), true, `missing release artifact: ${filename}`);
    assert.equal(
      sha256(await readFile(path)),
      manifest.get(filename),
      `checksum mismatch for ${filename}`,
    );
  }

  const actualReleaseFiles = (await readdir(directory))
    .filter((name) => name.startsWith(`easyserver-${version}-`))
    .sort();
  assert.deepEqual(
    actualReleaseFiles,
    expectedReleaseAssetNames(version).sort(),
    "release directory must contain exactly the required portable assets and checksum manifest",
  );
}

export function verifyPublishedAssetNames(names, version) {
  const actual = [...new Set(names.filter(Boolean))].sort();
  const expected = expectedReleaseAssetNames(version).sort();
  assert.deepEqual(actual, expected, "published GitHub Release assets must match the qualified target contract");
}

function parseChecksumManifest(text) {
  const entries = new Map();
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) {
      continue;
    }
    const match = /^([a-f0-9]{64})\s{2}(.+)$/u.exec(line);
    assert.ok(match, `invalid checksum line: ${line}`);
    const [, hash, filename] = match;
    assert.equal(entries.has(filename), false, `duplicate checksum entry: ${filename}`);
    entries.set(filename, hash);
  }
  return entries;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function rootVersion() {
  return JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")).version;
}

if (process.argv[1]?.endsWith("verify-release-assets.mjs")) {
  const [command, value] = process.argv.slice(2);
  const version = await rootVersion();
  if (command === "--write-checksums") {
    assert.ok(value, "release asset directory is required");
    await writeReleaseChecksums(resolve(value), version);
    await verifyReleaseAssets(resolve(value), version);
    process.stdout.write("Release asset set and checksums verified.\n");
  } else if (command === "--published-names") {
    assert.ok(value, "published asset name file is required");
    const names = (await readFile(resolve(value), "utf8")).split(/\r?\n/u);
    verifyPublishedAssetNames(names, version);
    process.stdout.write("Published release asset set verified.\n");
  } else {
    const directory = resolve(command ?? join(repositoryRoot, "dist", "release"));
    await verifyReleaseAssets(directory, version);
    process.stdout.write("Release asset set and checksums verified.\n");
  }
}
