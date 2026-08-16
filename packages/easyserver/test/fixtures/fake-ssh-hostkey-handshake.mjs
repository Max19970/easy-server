import { readFile, writeFile } from "node:fs/promises";

const [, , keySpecPath, ...args] = process.argv;
if (keySpecPath === undefined) {
  process.exitCode = 2;
} else {
  const spec = JSON.parse(await readFile(keySpecPath, "utf8"));
  const optionValues = args.flatMap((arg, index) =>
    arg === "-o" && args[index + 1] !== undefined ? [args[index + 1]] : [],
  );
  const knownHostsOption = optionValues.find((value) =>
    value.startsWith("UserKnownHostsFile="),
  );
  if (
    knownHostsOption === undefined ||
    !args.includes("-T") ||
    !args.includes("-N") ||
    !optionValues.includes("StrictHostKeyChecking=accept-new") ||
    !optionValues.includes("HashKnownHosts=no") ||
    !optionValues.includes("PasswordAuthentication=no") ||
    !optionValues.includes("KbdInteractiveAuthentication=no") ||
    !optionValues.includes("PubkeyAuthentication=no") ||
    !optionValues.includes("HostbasedAuthentication=no") ||
    !optionValues.includes("GSSAPIAuthentication=no")
  ) {
    process.stderr.write("fixture expected isolated accept-new host-key capture\n");
    process.exitCode = 2;
  } else {
    const knownHostsPath = knownHostsOption.slice("UserKnownHostsFile=".length);
    const portIndex = args.indexOf("-p");
    const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 22;
    const host = args.at(-1);
    const label = port === 22 ? host : `[${host}]:${port}`;
    await writeFile(
      knownHostsPath,
      `${label} ${spec.keyType} ${spec.key}\n`,
      "utf8",
    );
    process.stderr.write(`${host}: Permission denied (publickey).\n`);
    process.exitCode = 255;
  }
}
