import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "verify-packaged-install must be run through npm");

const temporaryRoot = await mkdtemp(join(tmpdir(), "easycompute-packaged-install-"));
const artifactDirectory = join(temporaryRoot, "artifacts");
await mkdir(artifactDirectory, { recursive: true });

const rootManifest = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8"),
);
assert.equal(rootManifest.private, true, "workspace root must remain non-publishable");
assertRootPublishBlocked();

try {
  const sdkTarball = pack("packages/plugin-sdk");
  const cliTarball = pack("packages/easycompute");
  const vastTarball = pack("plugins/vastai");
  const intelionTarball = pack("plugins/intelion");
  const exampleTarball = packExamplePlugin();

  await verifyCoreOnlyInstall(sdkTarball, cliTarball);
  await verifyPluginInstall({
    packageName: "@easycompute/plugin-vastai",
    providerId: "vastai",
    pluginTarball: vastTarball,
    absentPackageName: "@easycompute/plugin-intelion",
    sdkTarball,
    cliTarball,
  });
  await verifyPluginInstall({
    packageName: "@easycompute/plugin-intelion",
    providerId: "intelion",
    pluginTarball: intelionTarball,
    absentPackageName: "@easycompute/plugin-vastai",
    sdkTarball,
    cliTarball,
  });
  await verifyPluginInstall({
    packageName: "@easycompute/example-provider",
    pluginId: "example.provider-plugin",
    providerId: "example",
    pluginTarball: exampleTarball,
    absentPackageName: "@easycompute/plugin-vastai",
    sdkTarball,
    cliTarball,
  });

  process.stdout.write("Packaged install verification passed.\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function assertRootPublishBlocked() {
  const result = spawnSync(
    process.execPath,
    [npmCli, "publish", "--dry-run", "--json"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0, "workspace root publish must fail");
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /Workspace root is private and must not be published\./,
  );
}

function pack(packageDirectory) {
  const result = runNpm(
    [
      "pack",
      resolve(repositoryRoot, packageDirectory),
      "--json",
      "--pack-destination",
      artifactDirectory,
    ],
    repositoryRoot,
  );
  const packed = JSON.parse(result.stdout);
  assert.equal(packed.length, 1, `expected one tarball for ${packageDirectory}`);
  assertTarballFiles(packed[0], packageDirectory);
  return join(artifactDirectory, packed[0].filename);
}

function packExamplePlugin() {
  const packageDirectory = "examples/minimal-provider-plugin";
  const result = runNpm(
    [
      "pack",
      resolve(repositoryRoot, packageDirectory),
      "--json",
      "--pack-destination",
      artifactDirectory,
    ],
    repositoryRoot,
  );
  const packed = JSON.parse(result.stdout);
  assert.equal(packed.length, 1, "expected one minimal example tarball");
  const paths = packed[0].files.map((file) => file.path);
  assert.deepEqual(
    [...paths].sort(),
    ["LICENSE", "README.md", "index.mjs", "package.json"],
    "minimal example tarball must contain only the documented scaffold",
  );
  return join(artifactDirectory, packed[0].filename);
}

function assertTarballFiles(packResult, packageDirectory) {
  const paths = packResult.files.map((file) => file.path);
  for (const required of ["LICENSE", "README.md", "package.json"]) {
    assert.equal(
      paths.includes(required),
      true,
      `${packageDirectory} tarball must contain ${required}`,
    );
  }
  for (const path of paths) {
    assert.equal(
      path === "LICENSE" ||
        path === "README.md" ||
        path === "package.json" ||
        path.startsWith("dist/"),
      true,
      `${packageDirectory} tarball contains unexpected path: ${path}`,
    );
  }
}

async function verifyCoreOnlyInstall(sdkTarball, cliTarball) {
  const prefix = await createPrefix("core");
  installGlobally(prefix, sdkTarball, cliTarball);

  assertPackageAbsent(prefix, "@easycompute/plugin-vastai");
  assertPackageAbsent(prefix, "@easycompute/plugin-intelion");

  const result = runCli(prefix, "plugins", "list");
  assert.equal(result.stdout, "No provider plugins configured.\n");
  assert.equal(runInstalledExecutable(prefix, "--version").stdout, "0.1.0\n");
}

async function verifyPluginInstall({
  packageName,
  providerId,
  pluginId = providerId,
  pluginTarball,
  absentPackageName,
  sdkTarball,
  cliTarball,
}) {
  const prefix = await createPrefix(providerId);
  installGlobally(prefix, sdkTarball, cliTarball);
  // Before public npm publication the plugin's SDK range cannot resolve from the
  // registry yet, so provide the packed SDK alongside the selected plugin.
  installGlobally(prefix, sdkTarball, pluginTarball);

  assertPackagePresent(prefix, packageName);
  assertPackageAbsent(prefix, absentPackageName);

  const add = runCli(prefix, "plugins", "add", packageName);
  assert.equal(add.stdout, `Added ${pluginId}\n`);

  const list = runCli(prefix, "plugins", "list");
  assert.match(list.stdout, new RegExp(`^loaded\\s+${pluginId} provider=${providerId}$`, "m"));

  runCli(prefix, "plugins", "disable", packageName);
  assert.equal(runCli(prefix, "--version").stdout, "0.1.0\n");
}

async function createPrefix(name) {
  const prefix = join(temporaryRoot, `prefix-${name}`);
  await mkdir(prefix, { recursive: true });
  return prefix;
}

function installGlobally(prefix, ...tarballs) {
  runNpm(
    ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", ...tarballs],
    repositoryRoot,
  );
}

function runCli(prefix, ...args) {
  const cliPath = join(
    globalNodeModules(prefix),
    "@easycompute",
    "cli",
    "dist",
    "cli.js",
  );
  return run(process.execPath, [cliPath, ...args], repositoryRoot, cliEnvironment(prefix));
}

function runInstalledExecutable(prefix, ...args) {
  const executable =
    process.platform === "win32"
      ? join(prefix, "easycompute.cmd")
      : join(prefix, "bin", "easycompute");
  assert.equal(existsSync(executable), true, "npm must expose the easycompute executable");

  if (process.platform === "win32") {
    const command = `"${executable}" ${args.join(" ")}`;
    const result = spawnSync(command, {
      cwd: repositoryRoot,
      env: cliEnvironment(prefix),
      encoding: "utf8",
      shell: true,
    });
    return assertSuccessful(result, command);
  }

  return run(executable, args, repositoryRoot, cliEnvironment(prefix));
}

function cliEnvironment(prefix) {
  return {
    ...process.env,
    EASYCOMPUTE_STATE_FILE: join(prefix, "easycompute-state.json"),
    EASYCOMPUTE_DAEMON_FILE: join(prefix, "easycompute-daemon.json"),
  };
}

function globalNodeModules(prefix) {
  return runNpm(["root", "--global", "--prefix", prefix], repositoryRoot).stdout.trim();
}

function assertPackagePresent(prefix, packageName) {
  assert.equal(packageExists(prefix, packageName), true, `${packageName} should be installed`);
}

function assertPackageAbsent(prefix, packageName) {
  assert.equal(packageExists(prefix, packageName), false, `${packageName} must not be installed`);
}

function packageExists(prefix, packageName) {
  const [scope, name] = packageName.split("/");
  return existsSync(join(globalNodeModules(prefix), scope, name));
}

function runNpm(args, cwd) {
  return run(process.execPath, [npmCli, ...args], cwd);
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  return assertSuccessful(result, `${command} ${args.join(" ")}`);
}

function assertSuccessful(result, displayCommand) {
  if (result.status !== 0) {
    throw new Error(
      [
        `${displayCommand} failed with status ${result.status}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result;
}
