import { spawnSync } from "node:child_process";
import { rename, writeFile } from "node:fs/promises";

const [, , recordPath, ...args] = process.argv;

async function writeJson(path, value) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value), "utf8");
  await rename(temporaryPath, path);
}

if (recordPath === undefined) {
  process.exitCode = 2;
} else {
  await writeJson(recordPath, args);

  const passwordFile = process.env.EASYCOMPUTE_SSH_PASSWORD_FILE;
  const askpass = process.env.SSH_ASKPASS;
  if (passwordFile !== undefined && askpass !== undefined) {
    const result = spawnSync(askpass, ["Password:"], {
      env: process.env,
      encoding: "utf8",
      windowsHide: true,
    });
    await writeJson(`${recordPath}.auth.json`, {
      askpassRequire: process.env.SSH_ASKPASS_REQUIRE,
      password: result.stdout.trimEnd(),
      passwordFile,
      status: result.status,
    });
  }

  process.stdin.pipe(process.stdout);
}
