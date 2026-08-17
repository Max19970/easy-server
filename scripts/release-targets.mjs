import assert from "node:assert/strict";

export const RELEASE_TARGETS = Object.freeze([
  Object.freeze({
    id: "windows-x64",
    name: "Windows 11 x64",
    runner: "windows-latest",
    platform: "win32",
    arch: "x64",
    archiveExtension: ".zip",
  }),
  Object.freeze({
    id: "linux-x64",
    name: "Ubuntu 24.04 x64",
    runner: "ubuntu-24.04",
    platform: "linux",
    arch: "x64",
    archiveExtension: ".tar.gz",
  }),
  Object.freeze({
    id: "macos-arm64",
    name: "macOS 15 arm64",
    runner: "macos-15",
    platform: "darwin",
    arch: "arm64",
    archiveExtension: ".tar.gz",
  }),
]);

export function validateReleaseTargets(targets = RELEASE_TARGETS) {
  assert.ok(Array.isArray(targets) && targets.length > 0, "release targets must be non-empty");
  const ids = new Set();
  const runtimeKeys = new Set();
  for (const target of targets) {
    assert.match(target.id ?? "", /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "release target id must be stable");
    assert.ok(target.name, `${target.id} must have a display name`);
    assert.ok(target.runner, `${target.id} must have a GitHub runner`);
    assert.ok(target.platform, `${target.id} must have a Node platform`);
    assert.ok(target.arch, `${target.id} must have a Node architecture`);
    assert.ok([".zip", ".tar.gz"].includes(target.archiveExtension), `${target.id} must define a supported archive format`);
    assert.equal(ids.has(target.id), false, `duplicate release target id: ${target.id}`);
    ids.add(target.id);
    const runtimeKey = `${target.platform}/${target.arch}`;
    assert.equal(runtimeKeys.has(runtimeKey), false, `duplicate release target runtime: ${runtimeKey}`);
    runtimeKeys.add(runtimeKey);
  }
  return targets;
}

export function releaseTargetForRuntime(platform = process.platform, arch = process.arch) {
  validateReleaseTargets();
  const target = RELEASE_TARGETS.find((item) => item.platform === platform && item.arch === arch);
  assert.ok(target, `unsupported release artifact target: ${platform}/${arch}`);
  return target;
}

export function releaseAssetName(version, target) {
  assert.match(version, /^\d+\.\d+\.\d+$/u, "release version must be SemVer core");
  return `easyserver-${version}-${target.id}${target.archiveExtension}`;
}

export function releaseChecksumName(version) {
  assert.match(version, /^\d+\.\d+\.\d+$/u, "release version must be SemVer core");
  return `easyserver-${version}-SHA256SUMS.txt`;
}

export function githubMatrix() {
  validateReleaseTargets();
  return {
    include: RELEASE_TARGETS.map((target) => ({
      id: target.id,
      name: target.name,
      runner: target.runner,
      platform: target.platform,
      arch: target.arch,
      archiveExtension: target.archiveExtension,
    })),
  };
}

if (process.argv[1]?.endsWith("release-targets.mjs")) {
  const [command, argument] = process.argv.slice(2);
  if (command === "--github-matrix") {
    process.stdout.write(`${JSON.stringify(githubMatrix())}\n`);
  } else if (command === "--verify-current") {
    const target = RELEASE_TARGETS.find((item) => item.id === argument);
    assert.ok(target, `unknown release target: ${argument ?? ""}`);
    assert.equal(process.platform, target.platform, `${target.id} requires ${target.platform}`);
    assert.equal(process.arch, target.arch, `${target.id} requires ${target.arch}`);
    process.stdout.write(`${target.id}\n`);
  } else if (command === "--ids") {
    process.stdout.write(`${RELEASE_TARGETS.map((target) => target.id).join("\n")}\n`);
  } else {
    validateReleaseTargets();
    process.stdout.write(`${JSON.stringify(RELEASE_TARGETS)}\n`);
  }
}
