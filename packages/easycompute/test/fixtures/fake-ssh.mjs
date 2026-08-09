import { writeFile } from "node:fs/promises";

const [, , recordPath, ...args] = process.argv;
if (recordPath === undefined) {
  process.exitCode = 2;
} else {
  await writeFile(recordPath, JSON.stringify(args), "utf8");
  process.stdin.pipe(process.stdout);
}
