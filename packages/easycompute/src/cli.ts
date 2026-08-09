const VERSION = "0.0.0";

const help = `EasyCompute

Usage:
  easycompute --help
  easycompute --version
`;

const [command] = process.argv.slice(2);

if (command === undefined || command === "--help" || command === "-h") {
  process.stdout.write(help);
} else if (command === "--version" || command === "-v" || command === "version") {
  process.stdout.write(`${VERSION}\n`);
} else {
  process.stderr.write(`Unknown command: ${command}\n\n${help}`);
  process.exitCode = 1;
}
