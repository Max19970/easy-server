import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const destinationArgument = process.argv[2];
if (destinationArgument === undefined) {
  throw new Error("Usage: node scripts/copy-provider-http-safety.mjs <destination>");
}

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const source = resolve(scriptsDirectory, "internal", "provider-http-safety.mjs");
const destination = resolve(process.cwd(), destinationArgument);
await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
