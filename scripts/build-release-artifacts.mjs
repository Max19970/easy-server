import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  releaseAssetName,
  releaseTargetForRuntime,
} from "./release-targets.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WINDOWS_STATUS_DLL_INIT_FAILED = 0xc0000142;
const PROCESS_START_ATTEMPTS = 5;
const PROCESS_START_RETRY_DELAY_MS = 1_000;
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "release artifacts must be built through npm");

const target = releaseTargetForRuntime();
const rootManifest = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8"),
);
const version = rootManifest.version;
assert.match(version, /^\d+\.\d+\.\d+$/u, "workspace version must be a release version");

const bundleName = `easyserver-${version}-${target.id}`;
const artifactName = releaseAssetName(version, target);
const releaseDirectory = join(repositoryRoot, "dist", "release");
const temporaryRoot = await mkdtemp(join(tmpdir(), "easyserver-release-artifacts-"));

await rm(releaseDirectory, {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 250,
});
await mkdir(releaseDirectory, { recursive: true });

try {
  const packDirectory = join(temporaryRoot, "packs");
  const bundleDirectory = join(temporaryRoot, bundleName);
  await mkdir(packDirectory, { recursive: true });
  await mkdir(bundleDirectory, { recursive: true });

  const sdkTarball = pack("packages/plugin-sdk", packDirectory);
  const cliTarball = pack("packages/easyserver", packDirectory);
  const vastTarball = pack("plugins/vastai", packDirectory);
  const intelionTarball = pack("plugins/intelion", packDirectory);
  installPortablePrefix(bundleDirectory, sdkTarball, cliTarball);

  await rm(join(globalNodeModules(bundleDirectory), ".package-lock.json"), {
    force: true,
  });
  if (process.platform === "win32") {
    await rm(join(bundleDirectory, "easyserver"), { force: true });
  }
  await copyFile(join(repositoryRoot, "LICENSE"), join(bundleDirectory, "LICENSE"));
  await writeFile(
    join(bundleDirectory, "README.txt"),
    [
      `EasyServer ${version} portable ${target.name} bundle`,
      "",
      "Requires Node.js 24.18.1 on PATH. Node.js is not bundled.",
      `Run ${portableCommand()} --help to get started.`,
      "Provider Plugins are not bundled and remain opt-in.",
      "",
      "Documentation: https://github.com/Max19970/easy-server",
      "",
    ].join(process.platform === "win32" ? "\r\n" : "\n"),
    "utf8",
  );

  verifyPortablePrefix(bundleDirectory);

  const artifactPath = join(releaseDirectory, artifactName);
  createArchive(bundleDirectory, artifactPath);
  assert.equal(existsSync(artifactPath), true, "portable release archive must be created");

  await verifyReleaseArchive(artifactPath, vastTarball, intelionTarball);

  process.stdout.write(
    [
      `GitHub Release artifact verification passed for ${target.name}.`,
      `Artifact: dist/release/${artifactName}`,
      `SHA-256: ${sha256(await readFile(artifactPath))}`,
      "",
    ].join("\n"),
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function pack(packageDirectory, destination) {
  const result = runNpm(
    [
      "pack",
      resolve(repositoryRoot, packageDirectory),
      "--json",
      "--pack-destination",
      destination,
    ],
    repositoryRoot,
  );
  const packed = JSON.parse(result.stdout);
  assert.equal(packed.length, 1, `expected one tarball for ${packageDirectory}`);
  return join(destination, packed[0].filename);
}

function installPortablePrefix(prefix, ...tarballs) {
  runNpm(
    [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      ...tarballs,
    ],
    repositoryRoot,
  );
}

function verifyPortablePrefix(prefix) {
  const executable = installedExecutable(prefix);
  assert.equal(existsSync(executable), true, "portable bundle must expose the easyserver executable");
  assert.equal(
    existsSync(process.platform === "win32" ? join(prefix, "node.exe") : join(prefix, "bin", "node")),
    false,
    "portable bundle must not imply that Node.js is bundled",
  );
  assertPackagePresent(prefix, "@easyai101/easyserver");
  assertPackagePresent(prefix, "@easyai101/easyserver-plugin-sdk");
  assertPackageAbsent(prefix, "@easyai101/easyserver-plugin-vastai");
  assertPackageAbsent(prefix, "@easyai101/easyserver-plugin-intelion");
  assert.equal(
    lstatSync(packagePath(prefix, "@easyai101/easyserver")).isSymbolicLink(),
    false,
    "portable CLI must not be a workspace symlink",
  );
  assert.equal(
    lstatSync(packagePath(prefix, "@easyai101/easyserver-plugin-sdk")).isSymbolicLink(),
    false,
    "portable SDK must not be a workspace symlink",
  );
}

async function verifyReleaseArchive(archivePath, vastTarball, intelionTarball) {
  const extractionDirectory = join(temporaryRoot, "extracted");
  const outsideDirectory = join(temporaryRoot, "outside-cwd");
  await mkdir(extractionDirectory, { recursive: true });
  await mkdir(outsideDirectory, { recursive: true });
  extractArchive(archivePath, extractionDirectory);

  verifyPortablePrefix(extractionDirectory);
  verifyPortableTui(extractionDirectory);
  const environment = {
    ...process.env,
    EASYSERVER_STATE_FILE: join(outsideDirectory, "state.json"),
    EASYSERVER_DAEMON_FILE: join(outsideDirectory, "daemon.json"),
  };
  assert.equal(
    normalizeNewlines(
      runPortableExecutable(extractionDirectory, ["--version"], outsideDirectory, environment).stdout,
    ),
    `${version}\n`,
  );
  assert.match(
    runPortableExecutable(extractionDirectory, ["--help"], outsideDirectory, environment).stdout,
    /EasyServer/u,
  );
  assert.equal(
    normalizeNewlines(
      runPortableExecutable(
        extractionDirectory,
        ["plugins", "list"],
        outsideDirectory,
        environment,
      ).stdout,
    ),
    "No provider plugins configured.\n",
  );

  installPortablePrefix(extractionDirectory, vastTarball, intelionTarball);
  runPortableExecutable(
    extractionDirectory,
    ["plugins", "add", "@easyai101/easyserver-plugin-vastai"],
    outsideDirectory,
    environment,
  );
  runPortableExecutable(
    extractionDirectory,
    ["plugins", "add", "@easyai101/easyserver-plugin-intelion"],
    outsideDirectory,
    environment,
  );
  const plugins = runPortableExecutable(
    extractionDirectory,
    ["plugins", "list"],
    outsideDirectory,
    environment,
  ).stdout;
  assert.match(plugins, /loaded\s+vastai\s+provider=vastai/u);
  assert.match(plugins, /loaded\s+intelion\s+provider=intelion/u);
}

function verifyPortableTui(prefix) {
  if (process.platform !== "win32") {
    return;
  }
  const executable = installedExecutable(prefix);
  const smokeScript = join(repositoryRoot, "scripts", "verify-tui-windows-smoke.ps1");
  runPowerShell(
    [
      `& '${powerShellLiteral(smokeScript)}'`,
      "-Program 'cmd.exe'",
      `-ProgramArgsJson '${powerShellLiteral(JSON.stringify(["/d", "/c", executable]))}'`,
      "-ExitMode 'quit'",
      "-ExpectedText 'What do you want to do?'",
    ].join(" "),
  );
}

function createArchive(source, destination) {
  if (process.platform === "win32") {
    runPowerShell(
      [
        "Add-Type -AssemblyName System.IO.Compression.FileSystem;",
        `[IO.Compression.ZipFile]::CreateFromDirectory('${powerShellLiteral(source)}', '${powerShellLiteral(destination)}', [IO.Compression.CompressionLevel]::Optimal, $false)`,
      ].join(" "),
    );
    return;
  }
  run("tar", ["-czf", destination, "-C", source, "."], repositoryRoot);
}

function extractArchive(archive, destination) {
  if (process.platform === "win32") {
    runPowerShell(
      [
        "Add-Type -AssemblyName System.IO.Compression.FileSystem;",
        `[IO.Compression.ZipFile]::ExtractToDirectory('${powerShellLiteral(archive)}', '${powerShellLiteral(destination)}')`,
      ].join(" "),
    );
    return;
  }
  run("tar", ["-xzf", archive, "-C", destination], repositoryRoot);
}

function runPowerShell(command) {
  const nonInteractiveCommand = `$ProgressPreference = 'SilentlyContinue'; ${command}`;
  const result = spawnSyncForVerification(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", nonInteractiveCommand],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  return assertSuccessful(result, `powershell.exe ${command}`);
}

function powerShellLiteral(value) {
  return value.replaceAll("'", "''");
}

function portableCommand() {
  return process.platform === "win32" ? "easyserver.cmd" : "bin/easyserver";
}

function installedExecutable(prefix) {
  return process.platform === "win32"
    ? join(prefix, "easyserver.cmd")
    : join(prefix, "bin", "easyserver");
}

function globalNodeModules(prefix) {
  return process.platform === "win32"
    ? join(prefix, "node_modules")
    : join(prefix, "lib", "node_modules");
}

function runNpm(args, cwd) {
  return run(process.execPath, [npmCli, ...args], cwd);
}

function runPortableExecutable(prefix, args, cwd, env) {
  const executable = installedExecutable(prefix);
  if (process.platform !== "win32") {
    return run(executable, args, cwd, env);
  }
  const command = `"${executable}" ${args.map(quoteCmdArgument).join(" ")}`;
  const result = spawnSyncForVerification(command, [], {
    cwd,
    env,
    encoding: "utf8",
    shell: true,
  });
  return assertSuccessful(result, command);
}

function quoteCmdArgument(value) {
  return /[\s"&|<>^]/u.test(value)
    ? `"${value.replaceAll('"', '\\"')}"`
    : value;
}

function packagePath(prefix, packageName) {
  const [scope, name] = packageName.split("/");
  return join(globalNodeModules(prefix), scope, name);
}

function assertPackagePresent(prefix, packageName) {
  assert.equal(
    existsSync(packagePath(prefix, packageName)),
    true,
    `${packageName} should be present in the portable bundle`,
  );
}

function assertPackageAbsent(prefix, packageName) {
  assert.equal(
    existsSync(packagePath(prefix, packageName)),
    false,
    `${packageName} must not be bundled by default`,
  );
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function normalizeNewlines(value) {
  return value.replaceAll("\r\n", "\n");
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSyncForVerification(command, args, {
    cwd,
    env,
    encoding: "utf8",
  });
  return assertSuccessful(result, `${command} ${args.join(" ")}`);
}

function spawnSyncForVerification(command, args, options) {
  let result;
  for (let attempt = 0; attempt < PROCESS_START_ATTEMPTS; attempt += 1) {
    result = spawnSync(command, args, options);
    if (
      process.platform !== "win32" ||
      result.status !== WINDOWS_STATUS_DLL_INIT_FAILED
    ) {
      return result;
    }
    if (attempt + 1 < PROCESS_START_ATTEMPTS) {
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        PROCESS_START_RETRY_DELAY_MS * 2 ** attempt,
      );
    }
  }
  return result;
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
