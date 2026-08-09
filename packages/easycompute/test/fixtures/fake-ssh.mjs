import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

const [, , recordPath, ...args] = process.argv;
if (recordPath === undefined) {
  process.exitCode = 2;
} else {
  await writeFile(recordPath, JSON.stringify(args), "utf8");

  const passwordFile = process.env.EASYCOMPUTE_SSH_PASSWORD_FILE;
  const askpass = process.env.SSH_ASKPASS;
  if (passwordFile !== undefined && askpass !== undefined) {
    const result = spawnSync(askpass, ["Password:"], {
      env: process.env,
      encoding: "utf8",
      windowsHide: true,
    });
    await writeFile(
      `${recordPath}.auth.json`,
      JSON.stringify({
        askpassRequire: process.env.SSH_ASKPASS_REQUIRE,
        password: result.stdout.trimEnd(),
        passwordFile,
        status: result.status,
      }),
      "utf8",
    );
  }

  process.stdin.pipe(process.stdout);
}
