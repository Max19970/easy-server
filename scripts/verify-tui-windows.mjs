import assert from "node:assert/strict";
import { release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const smokeScript = join(repositoryRoot, "scripts", "verify-tui-windows-smoke.ps1");
const cli = join(repositoryRoot, "packages", "easyserver", "dist", "cli.js");
const errorFixture = join(
  repositoryRoot,
  "packages",
  "easyserver",
  "test",
  "fixtures",
  "tui-terminal-error.mjs",
);

assert.equal(process.platform, "win32", "TUI release qualification requires Windows");
assert.equal(process.arch, "x64", "TUI release qualification requires Windows x64");
assert.equal(process.version, "v24.18.1", "TUI release qualification requires Node.js 24.18.1");

const windowsBuild = Number(release().split(".")[2]);
assert.equal(
  Number.isInteger(windowsBuild) && windowsBuild >= 22000,
  true,
  `TUI release qualification requires Windows 11 (observed ${release()})`,
);

runSmoke(cli, ["-ExitMode", "quit", "-ResizeToNarrow"]);
runSmoke(cli, ["-ExitMode", "quit", "-Columns", "60", "-Rows", "20"]);
runSmoke(cli, ["-ExitMode", "quit", "-Columns", "80", "-Rows", "24"]);
runSmoke(cli, ["-ExitMode", "quit", "-Columns", "120", "-Rows", "40", "-ExpectColor"]);
runSmoke(cli, ["-ExitMode", "ctrl-c"]);
runSmoke(cli, ["-ExitMode", "quit", "-NoColor"]);
runSmoke(cli, ["-ExitMode", "quit", "-ScreenReader"]);
runSmoke(cli, ["-ExitMode", "quit", "-Relaunch"]);
runSmoke(errorFixture, ["-ExitMode", "error"]);

process.stdout.write(
  `Windows 11 x64 TUI terminal qualification passed on Node.js ${process.versions.node}.\n`,
);

function runSmoke(programArg, extraArgs) {
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    smokeScript,
    "-Program",
    process.execPath,
    "-ProgramArgsJson",
    JSON.stringify([programArg]),
    ...extraArgs,
  ];
  const result = spawnSync("powershell.exe", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `Windows TUI smoke failed: ${extraArgs.join(" ")}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  process.stdout.write(result.stdout);
}
