import { formatPluginStatuses, PluginHost } from "./plugin-host.js";
import { ProviderRegistry } from "./provider-registry.js";

const VERSION = "0.0.0";

const help = `EasyCompute

Usage:
  easycompute --help
  easycompute --version
  easycompute plugins list [--plugin <module> ...]
`;

await run(process.argv.slice(2));

async function run(args: readonly string[]): Promise<void> {
  const [command] = args;

  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(help);
    return;
  }

  if (command === "--version" || command === "-v" || command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (command === "plugins" && args[1] === "list") {
    try {
      const sources = parsePluginSources(args.slice(2));
      const registry = new ProviderRegistry();
      const host = new PluginHost(registry);
      await host.load(sources);
      process.stdout.write(formatPluginStatuses(host.listPlugins()));
    } catch (error) {
      process.stderr.write(`${errorMessage(error)}\n\n${help}`);
      process.exitCode = 1;
    }
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n\n${help}`);
  process.exitCode = 1;
}

function parsePluginSources(args: readonly string[]): readonly string[] {
  const sources: string[] = [];

  for (let index = 0; index < args.length; index += 2) {
    if (args[index] !== "--plugin" || args[index + 1] === undefined) {
      throw new Error("plugins list accepts only --plugin <module> pairs");
    }

    sources.push(args[index + 1]);
  }

  return sources;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
