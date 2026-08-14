import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WINDOWS_STATUS_DLL_INIT_FAILED = 0xc0000142;
const PROCESS_START_ATTEMPTS = 5;
const PROCESS_START_RETRY_DELAY_MS = 1_000;
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "verify-packaged-install must be run through npm");

const temporaryRoot = await mkdtemp(join(tmpdir(), "easyserver-packaged-install-"));
const artifactDirectory = join(temporaryRoot, "artifacts");
await mkdir(artifactDirectory, { recursive: true });

const rootManifest = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8"),
);
assert.equal(rootManifest.private, true, "workspace root must remain non-publishable");
assertRootPublishBlocked();

try {
  const sdkTarball = pack("packages/plugin-sdk");
  const cliTarball = pack("packages/easyserver");
  const vastTarball = pack("plugins/vastai");
  const intelionTarball = pack("plugins/intelion");
  const exampleTarball = packExamplePlugin();
  const externalTsPluginTarball = await verifyExternalSdkConsumer(sdkTarball);

  await verifyCoreOnlyInstall(sdkTarball, cliTarball);
  await verifyPluginInstall({
    packageName: "@easyai101/easyserver-plugin-vastai",
    providerId: "vastai",
    pluginTarball: vastTarball,
    absentPackageName: "@easyai101/easyserver-plugin-intelion",
    sdkTarball,
    cliTarball,
    requiredCredentialName: "api-key",
  });
  await verifyPluginInstall({
    packageName: "@easyai101/easyserver-plugin-intelion",
    providerId: "intelion",
    pluginTarball: intelionTarball,
    absentPackageName: "@easyai101/easyserver-plugin-vastai",
    sdkTarball,
    cliTarball,
    requiredCredentialName: "api-token",
  });
  await verifyPluginInstall({
    packageName: "@easyai101/easyserver-example-provider",
    pluginId: "example.provider-plugin",
    providerId: "example",
    pluginTarball: exampleTarball,
    absentPackageName: "@easyai101/easyserver-plugin-vastai",
    sdkTarball,
    cliTarball,
    providerCommand: ["provider", "example", "catalog", "show"],
    providerCommandOutput: "example-offer gpu=ExampleGPU price=0.00\n",
    requiredCredentialName: "api-key",
  });
  await verifyPluginInstall({
    packageName: "@easyai101/easyserver-external-ts-provider",
    pluginId: "external.ts-provider",
    providerId: "external-ts",
    pluginTarball: externalTsPluginTarball,
    absentPackageName: "@easyai101/easyserver-plugin-vastai",
    sdkTarball,
    cliTarball,
  });
  await verifyPackageLifecycle(sdkTarball, cliTarball, exampleTarball);

  process.stdout.write("Packaged install verification passed.\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function assertRootPublishBlocked() {
  const result = spawnSyncForVerification(
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

async function verifyExternalSdkConsumer(sdkTarball) {
  const consumer = join(temporaryRoot, "external-sdk-consumer");
  await mkdir(join(consumer, "src"), { recursive: true });
  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify(
      {
        name: "@easyai101/easyserver-external-ts-provider",
        version: "0.1.0",
        private: true,
        type: "module",
        main: "dist/index.js",
        files: ["dist"],
        engines: {
          node: ">=24.18.1 <25",
        },
        dependencies: {
          "@easyai101/easyserver-plugin-sdk": "^0.2.0",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(consumer, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          types: ["node"],
          rootDir: "src",
          outDir: "dist",
          noEmitOnError: true,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(consumer, "src", "index.ts"),
    `import { PassThrough } from "node:stream";
import {
  PLUGIN_SDK_VERSION,
  parseProviderPlugin,
  type AccessAdapter,
  type AccessTransportSession,
  type OperationContext,
  type ProviderAdapter,
  type ProviderOperationContext,
  type ProviderPlugin,
} from "@easyai101/easyserver-plugin-sdk";

class ExternalProvider implements ProviderAdapter {
  readonly providerId = "external-ts";

  async listInstances(_context: ProviderOperationContext) {
    return [];
  }

  async getInstance(
    _providerExternalId: string,
    _context: ProviderOperationContext,
  ) {
    return undefined;
  }
}

class ExternalAccessAdapter implements AccessAdapter {
  readonly kind = "external-ts:tcp";

  async openTcpForward(): Promise<AccessTransportSession> {
    return {
      async openChannel(_context: OperationContext) {
        const stream = new PassThrough();
        return {
          stream,
          async close() {
            stream.destroy();
          },
        };
      },
      async close() {},
    };
  }
}

const plugin: ProviderPlugin = {
  manifest: {
    id: "external.ts-provider",
    displayName: "External TypeScript Provider",
    version: "0.1.0",
    compatibility: {
      easyserver: "^0.2.0",
      pluginSdk: "^0.2.0",
    },
    provider: {
      id: "external-ts",
      displayName: "External TypeScript Provider",
      capabilities: [],
    },
  },
  provider: new ExternalProvider(),
  accessAdapters: [new ExternalAccessAdapter()],
};

const parsed = parseProviderPlugin(plugin);
const adapter = parsed.accessAdapters?.[0];
if (
  parsed.manifest.id !== "external.ts-provider" ||
  PLUGIN_SDK_VERSION !== "0.2.0" ||
  adapter === undefined
) {
  throw new Error("Unexpected public SDK runtime result");
}
const transport = await adapter.openTcpForward(
  { id: "external-tcp", kind: "external-ts:tcp", mode: "tcp-forward" },
  "remote-1",
  { host: "127.0.0.1", port: 8188 },
  {
    signal: new AbortController().signal,
    registerCleanup() {},
    async resolveSecret() {
      throw new Error("No secret expected");
    },
    async resolveCredential() {
      throw new Error("No credential expected");
    },
  },
);
const channel = await transport.openChannel({ signal: new AbortController().signal });
if (!(channel.stream instanceof PassThrough)) {
  throw new Error("Public AccessChannel stream is not a Node Duplex");
}
await channel.close();
await transport.close();

export default plugin;
`,
    "utf8",
  );

  runNpm(
    ["install", "--no-save", "--no-audit", "--no-fund", sdkTarball],
    consumer,
  );
  const installed = JSON.parse(
    runNpm(
      ["ls", "@easyai101/easyserver-plugin-sdk", "--depth=0", "--json"],
      consumer,
    ).stdout,
  );
  assert.equal(
    installed.dependencies?.["@easyai101/easyserver-plugin-sdk"]?.version,
    "0.2.0",
    "external consumer must resolve the packed SDK version",
  );

  const tsc = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
  run(process.execPath, [tsc, "--project", "tsconfig.json"], consumer);
  const runtime = run(
    process.execPath,
    [join(consumer, "dist", "index.js")],
    consumer,
  );
  assert.equal(runtime.stdout, "");

  const packed = JSON.parse(
    runNpm(
      ["pack", consumer, "--json", "--pack-destination", artifactDirectory],
      repositoryRoot,
    ).stdout,
  );
  assert.equal(packed.length, 1, "expected one external TypeScript plugin tarball");
  const paths = packed[0].files.map((file) => file.path);
  for (const path of paths) {
    assert.equal(
      path === "package.json" || path.startsWith("dist/"),
      true,
      `external TypeScript plugin tarball contains unexpected path: ${path}`,
    );
  }
  return join(artifactDirectory, packed[0].filename);
}

async function verifyCoreOnlyInstall(sdkTarball, cliTarball) {
  const prefix = await createPrefix("core");
  installGlobally(prefix, sdkTarball, cliTarball);

  assertPackageAbsent(prefix, "@easyai101/easyserver-plugin-vastai");
  assertPackageAbsent(prefix, "@easyai101/easyserver-plugin-intelion");
  verifyInstalledTui(prefix);

  const result = runCli(prefix, "plugins", "list");
  assert.equal(result.stdout, "No provider plugins configured.\n");
  assert.equal(runInstalledExecutable(prefix, "--version").stdout, "0.2.0\n");

  const diagnostics = JSON.parse(runCli(prefix, "doctor").stdout);
  assert.equal(diagnostics.schemaVersion, 1);
  assert.equal(diagnostics.easyserver.version, "0.2.0");
  assert.deepEqual(diagnostics.plugins, []);
  assert.equal(diagnostics.state.status, "empty");
}

async function verifyPluginInstall({
  packageName,
  providerId,
  pluginId = providerId,
  pluginTarball,
  absentPackageName,
  sdkTarball,
  cliTarball,
  providerCommand,
  providerCommandOutput,
  requiredCredentialName,
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
  const credentialStatus =
    requiredCredentialName === undefined
      ? ""
      : ` credentials=missing:${requiredCredentialName}`;
  assert.match(
    list.stdout,
    new RegExp(
      `^loaded\\s+${pluginId} provider=${providerId}${credentialStatus}$`,
      "m",
    ),
  );

  if (providerCommand !== undefined) {
    assert.equal(runCli(prefix, ...providerCommand).stdout, providerCommandOutput);
  }

  runCli(prefix, "plugins", "disable", packageName);
  assert.equal(runCli(prefix, "--version").stdout, "0.2.0\n");
}

async function verifyPackageLifecycle(sdkTarball, cliTarball, pluginTarball) {
  const prefix = await createPrefix("lifecycle");
  const pluginPackage = "@easyai101/easyserver-example-provider";
  installGlobally(prefix, sdkTarball, cliTarball, pluginTarball);
  runCli(prefix, "plugins", "add", pluginPackage);

  const statePath = stateFile(prefix);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.plugins[0].credentials = [
    {
      name: "api-key",
      secretRef: "secret:550e8400-e29b-41d4-a716-446655440000",
    },
  ];
  state.instances = [
    {
      id: "instance:550e8400-e29b-41d4-a716-446655440001",
      providerId: "example",
      providerExternalId: "remote-1",
    },
  ];
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  const expectedState = await readFile(statePath, "utf8");

  installGlobally(prefix, sdkTarball, cliTarball);
  assert.equal(
    await readFile(statePath, "utf8"),
    expectedState,
    "reinstalling compatible core packages must preserve Local State and Secret References",
  );
  assert.match(
    runCli(prefix, "plugins", "list").stdout,
    /^loaded\s+example\.provider-plugin provider=example credentials=ready$/m,
  );

  uninstallGlobally(prefix, pluginPackage);
  assertPackageAbsent(prefix, pluginPackage);
  const missing = runCli(prefix, "plugins", "list");
  assert.match(missing.stdout, /^failed\s+@easyai101\/easyserver-example-provider\s+error=/m);
  assert.equal(
    await readFile(statePath, "utf8"),
    expectedState,
    "a missing configured plugin must not rewrite Local State",
  );

  installGlobally(prefix, sdkTarball, pluginTarball);
  assert.match(
    runCli(prefix, "plugins", "list").stdout,
    /^loaded\s+example\.provider-plugin provider=example credentials=ready$/m,
  );
  assert.equal(await readFile(statePath, "utf8"), expectedState);

  uninstallGlobally(prefix, "@easyai101/easyserver");
  assertPackageAbsent(prefix, "@easyai101/easyserver");
  assert.equal(
    await readFile(statePath, "utf8"),
    expectedState,
    "uninstalling the core package must leave user state untouched",
  );

  installGlobally(prefix, sdkTarball, cliTarball);
  assert.match(
    runCli(prefix, "plugins", "list").stdout,
    /^loaded\s+example\.provider-plugin provider=example credentials=ready$/m,
  );
  assert.equal(await readFile(statePath, "utf8"), expectedState);
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

function uninstallGlobally(prefix, ...packageNames) {
  runNpm(
    ["uninstall", "--global", "--prefix", prefix, "--no-audit", "--no-fund", ...packageNames],
    repositoryRoot,
  );
}

function stateFile(prefix) {
  return join(prefix, "easyserver-state.json");
}

function runCli(prefix, ...args) {
  const cliPath = join(
    globalNodeModules(prefix),
    "@easyai101",
    "easyserver",
    "dist",
    "cli.js",
  );
  return run(process.execPath, [cliPath, ...args], repositoryRoot, cliEnvironment(prefix));
}

function runInstalledExecutable(prefix, ...args) {
  const executable = installedExecutable(prefix);
  assert.equal(existsSync(executable), true, "npm must expose the easyserver executable");

  if (process.platform === "win32") {
    const command = `"${executable}" ${args.join(" ")}`;
    const result = spawnSyncForVerification(command, [], {
      cwd: repositoryRoot,
      env: cliEnvironment(prefix),
      encoding: "utf8",
      shell: true,
    });
    return assertSuccessful(result, command);
  }

  return run(executable, args, repositoryRoot, cliEnvironment(prefix));
}

function installedExecutable(prefix) {
  return process.platform === "win32"
    ? join(prefix, "easyserver.cmd")
    : join(prefix, "bin", "easyserver");
}

function verifyInstalledTui(prefix) {
  if (process.platform !== "win32") {
    return;
  }

  const executable = installedExecutable(prefix);
  assert.equal(existsSync(executable), true, "npm must expose the easyserver executable");
  runWindowsTuiSmoke(executable, "No provider plugins configured.");
}

function runWindowsTuiSmoke(executable, expectedText) {
  const script = join(repositoryRoot, "scripts", "verify-tui-windows-smoke.ps1");
  const command = [
    `& '${powerShellLiteral(script)}'`,
    "-Program 'cmd.exe'",
    `-ProgramArgsJson '${powerShellLiteral(JSON.stringify(["/d", "/c", executable]))}'`,
    "-ExitMode 'quit'",
    `-ExpectedText '${powerShellLiteral(expectedText)}'`,
  ].join(" ");
  return run(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    repositoryRoot,
  );
}

function powerShellLiteral(value) {
  return value.replaceAll("'", "''");
}

function cliEnvironment(prefix) {
  return {
    ...process.env,
    EASYSERVER_STATE_FILE: join(prefix, "easyserver-state.json"),
    EASYSERVER_DAEMON_FILE: join(prefix, "easyserver-daemon.json"),
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
