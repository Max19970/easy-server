import { readFile } from "node:fs/promises";

const [, , keySpecPath, ...args] = process.argv;
if (keySpecPath === undefined) {
  process.exitCode = 2;
} else {
  const spec = JSON.parse(await readFile(keySpecPath, "utf8"));
  const portIndex = args.indexOf("-p");
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 22;
  const host = args.at(-1);
  const label = port === 22 ? host : `[${host}]:${port}`;
  process.stdout.write(`${label} ${spec.keyType} ${spec.key}\n`);
}
