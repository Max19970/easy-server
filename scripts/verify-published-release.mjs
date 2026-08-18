import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  releaseAssetName,
  releaseChecksumName,
  releaseTargetForRuntime,
} from "./release-targets.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WINDOWS_STATUS_DLL_INIT_FAILED = 0xc0000142;
const PROCESS_START_ATTEMPTS = 5;
const PROCESS_START_RETRY_DELAY_MS = 1_000;
const releaseDirectory = resolve(process.argv[2] ?? "");
assert.ok(process.argv[2], "published release download directory is required");
const target = releaseTargetForRuntime();
const rootManifest = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8"),
);
const version = rootManifest.version;
const vastPluginSpec = exactDevDependencySpec(
  rootManifest,
  "@easyai101/easyserver-plugin-vastai",
);
const intelionPluginSpec = exactDevDependencySpec(
  rootManifest,
  "@easyai101/easyserver-plugin-intelion",
);
const artifactName = releaseAssetName(version, target);
const checksumName = releaseChecksumName(version);
const artifactPath = join(releaseDirectory, artifactName);
const checksumPath = join(releaseDirectory, checksumName);
assert.equal(existsSync(artifactPath), true, `published artifact is missing: ${artifactName}`);
assert.equal(existsSync(checksumPath), true, `published checksum manifest is missing: ${checksumName}`);

const expectedHash = checksumFor(
  await readFile(checksumPath, "utf8"),
  artifactName,
);
assert.equal(
  sha256(await readFile(artifactPath)),
  expectedHash,
  `published checksum mismatch for ${artifactName}`,
);

const temporaryRoot = await mkdtemp(join(tmpdir(), "easyserver-published-release-"));
try {
  const extracted = join(temporaryRoot, "extracted");
  const outside = join(temporaryRoot, "outside");
  await mkdir(extracted, { recursive: true });
  await mkdir(outside, { recursive: true });
  extractArchive(artifactPath, extracted);

  const environment = {
    ...process.env,
    EASYSERVER_STATE_FILE: join(outside, "state.json"),
    EASYSERVER_DAEMON_FILE: join(outside, "daemon.json"),
  };
  assert.equal(
    normalizeNewlines(runPortable(extracted, ["--version"], outside, environment).stdout),
    `${version}\n`,
  );
  assert.match(runPortable(extracted, ["--help"], outside, environment).stdout, /EasyServer/u);
  assert.equal(
    normalizeNewlines(runPortable(extracted, ["plugins", "list"], outside, environment).stdout),
    "No provider plugins configured.\n",
  );

  runNpm([
    "install",
    "--global",
    "--prefix",
    extracted,
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    vastPluginSpec,
    intelionPluginSpec,
  ]);
  runPortable(
    extracted,
    ["plugins", "add", "@easyai101/easyserver-plugin-vastai"],
    outside,
    environment,
  );
  runPortable(
    extracted,
    ["plugins", "add", "@easyai101/easyserver-plugin-intelion"],
    outside,
    environment,
  );
  const plugins = runPortable(extracted, ["plugins", "list"], outside, environment).stdout;
  assert.match(plugins, /loaded\s+vastai\s+provider=vastai/u);
  assert.match(plugins, /loaded\s+intelion\s+provider=intelion/u);

  process.stdout.write(`Published ${artifactName} verification passed on ${target.name}.\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}

function exactDevDependencySpec(manifest, packageName) {
  const packageVersion = manifest.devDependencies?.[packageName];
  assert.match(
    packageVersion ?? "",
    /^\d+\.\d+\.\d+$/u,
    `${packageName} integration baseline must be an exact version`,
  );
  return `${packageName}@${packageVersion}`;
}

function checksumFor(manifest, filename) {
  const matches = manifest
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => /^([a-f0-9]{64})\s{2}(.+)$/u.exec(line))
    .filter(Boolean)
    .filter((match) => match[2] === filename);
  assert.equal(matches.length, 1, `checksum manifest must contain exactly one entry for ${filename}`);
  return matches[0][1];
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

function runPortable(prefix, args, cwd, env) {
  const executable = process.platform === "win32"
    ? join(prefix, "easyserver.cmd")
    : join(prefix, "bin", "easyserver");
  assert.equal(existsSync(executable), true, "published portable launcher is missing");
  if (process.platform !== "win32") {
    return run(executable, args, cwd, env);
  }
  const command = `"${executable}" ${args.map(quoteCmdArgument).join(" ")}`;
  return assertSuccessful(
    spawnSyncForVerification(command, [], { cwd, env, encoding: "utf8", shell: true }),
    command,
  );
}

function runNpm(args) {
  if (process.platform !== "win32") {
    return run("npm", args, repositoryRoot);
  }
  const command = `npm ${args.map(quoteCmdArgument).join(" ")}`;
  return assertSuccessful(
    spawnSyncForVerification(command, [], {
      cwd: repositoryRoot,
      env: process.env,
      encoding: "utf8",
      shell: true,
    }),
    command,
  );
}

function runPowerShell(command) {
  return run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `$ProgressPreference = 'SilentlyContinue'; ${command}`],
    repositoryRoot,
  );
}

function powerShellLiteral(value) {
  return value.replaceAll("'", "''");
}

function quoteCmdArgument(value) {
  return /[\s"&|<>^]/u.test(value)
    ? `"${value.replaceAll('"', '\\"')}"`
    : value;
}

function normalizeNewlines(value) {
  return value.replaceAll("\r\n", "\n");
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function run(command, args, cwd, env = process.env) {
  return assertSuccessful(
    spawnSyncForVerification(command, args, { cwd, env, encoding: "utf8" }),
    `${command} ${args.join(" ")}`,
  );
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
