import { writeFile } from "node:fs/promises";

const [, , recordPath, ...args] = process.argv;
if (recordPath !== undefined) {
  await writeFile(recordPath, JSON.stringify(args), "utf8");
}

process.stderr.write("fixture abrupt SSH exit\n");
await new Promise((resolve) => setTimeout(resolve, 25));
process.exitCode = 7;
