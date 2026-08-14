export interface CliHelpNode {
  readonly name: string;
  readonly summary: string;
  readonly purpose: string;
  readonly usage?: readonly string[];
  readonly options?: readonly { readonly syntax: string; readonly description: string }[];
  readonly notes?: readonly string[];
  readonly example?: string;
  readonly children?: readonly CliHelpNode[];
}

const coreCommands: readonly CliHelpNode[] = [
  {
    name: "doctor",
    summary: "Print privacy-safe diagnostics for support and troubleshooting.",
    purpose:
      "Collect EasyServer, runtime, plugin, daemon and SSH readiness information without exposing credential values, daemon tokens, private keys or provider resource identifiers.",
    usage: [""],
    notes: [
      "The output is designed to be safe to review before sharing. Raw logs are not equivalent and may contain sensitive data.",
    ],
    example: "easyserver doctor",
  },
  {
    name: "plugins",
    summary: "Register Provider Plugins, control readiness and bind credentials.",
    purpose:
      "Manage the Provider Plugins that extend EasyServer. Installing a package and registering it with EasyServer are separate actions.",
    notes: [
      "A Provider Plugin owns provider-specific API behavior; EasyServer core keeps provider-specific acquisition details outside the universal lifecycle surface.",
      "Credential values are stored through EasyServer's Secret Store. The CLI accepts the value through an environment variable instead of echoing it as an argument.",
    ],
    children: [
      {
        name: "list",
        summary: "List configured plugins and readiness without resolving secret values.",
        purpose:
          "Inspect configured Provider Plugins, optionally probing additional installed modules without registering them.",
        usage: ["[--plugin <module> ...]"],
        options: [
          {
            syntax: "--plugin <module>",
            description: "Also inspect an installed plugin module; repeat for multiple modules.",
          },
        ],
        example: "easyserver plugins list --plugin @easyai101/easyserver-plugin-vastai",
      },
      {
        name: "add",
        summary: "Validate and register an installed Provider Plugin module.",
        purpose:
          "Add an installed plugin module to EasyServer Local State. This does not install the npm package for you.",
        usage: ["<module>"],
        example: "easyserver plugins add @easyai101/easyserver-plugin-vastai",
      },
      {
        name: "enable",
        summary: "Enable a configured Provider Plugin.",
        purpose:
          "Allow a configured Provider Plugin to participate in provider inventory, lifecycle and feature operations.",
        usage: ["<module>"],
        example: "easyserver plugins enable @easyai101/easyserver-plugin-vastai",
      },
      {
        name: "disable",
        summary: "Disable a configured Provider Plugin without deleting its registration.",
        purpose:
          "Stop a configured Provider Plugin from participating in runtime operations while preserving its registration and credential bindings.",
        usage: ["<module>"],
        example: "easyserver plugins disable @easyai101/easyserver-plugin-vastai",
      },
      {
        name: "credential",
        summary: "Bind or remove Provider Plugin credentials through the Secret Store.",
        purpose:
          "Manage credential bindings declared by a Provider Plugin without printing or persisting raw secret values in Local State.",
        children: [
          {
            name: "set",
            summary: "Store a credential from an environment variable.",
            purpose:
              "Read one secret value from the named environment variable, store it in EasyServer's Secret Store and bind the resulting Secret Reference to the plugin credential name.",
            usage: ["<module> <name> --env <variable>"],
            options: [
              {
                syntax: "--env <variable>",
                description: "Environment variable containing the secret value. The variable must be non-empty.",
              },
            ],
            example:
              "easyserver plugins credential set @easyai101/easyserver-plugin-vastai api-key --env VAST_API_KEY",
          },
          {
            name: "remove",
            summary: "Remove one stored credential binding from a Provider Plugin.",
            purpose:
              "Delete the plugin credential binding and its stored secret value without disabling or removing the plugin itself.",
            usage: ["<module> <name>"],
            example:
              "easyserver plugins credential remove @easyai101/easyserver-plugin-vastai api-key",
          },
        ],
      },
    ],
  },
  {
    name: "instances",
    summary: "Inspect and manage normalized Compute Instance lifecycle.",
    purpose:
      "Work with provider resources through EasyServer canonical Compute Instance IDs. Provider-specific IDs remain provider-owned details; lifecycle commands use the canonical EasyServer identity.",
    notes: [
      "Stopping a Compute Instance is not the same as releasing it. A stopped resource may remain billable depending on provider semantics.",
      "Destructive operations preserve per-target outcomes so a partial bulk failure never becomes a false all-or-nothing result.",
    ],
    children: [
      {
        name: "list",
        summary: "List normalized inventory from all healthy configured providers.",
        purpose:
          "Show managed and discovered Compute Instances while preserving useful partial inventory when one provider fails.",
        usage: [""],
        example: "easyserver instances list",
      },
      {
        name: "inspect",
        summary: "Inspect one Compute Instance by canonical EasyServer ID.",
        purpose: "Print the normalized record for one canonical Compute Instance.",
        usage: ["<instance-id>"],
        example: "easyserver instances inspect instance:01234567-89ab-cdef-0123-456789abcdef",
      },
      {
        name: "access-methods",
        summary: "List connection methods currently available for one Compute Instance.",
        purpose:
          "Discover provider-declared Access Methods that EasyServer can use for local TCP forwarding.",
        usage: ["<instance-id>"],
        example: "easyserver instances access-methods instance:01234567-89ab-cdef-0123-456789abcdef",
      },
      {
        name: "adopt",
        summary: "Adopt a discovered provider resource into EasyServer management.",
        purpose:
          "Persist the canonical mapping for a discovered Compute Instance so destructive managed lifecycle actions can be enabled safely.",
        usage: ["<instance-id>"],
        example: "easyserver instances adopt instance:01234567-89ab-cdef-0123-456789abcdef",
      },
      lifecycleHelp("start", "Request that one or more Compute Instances start running."),
      lifecycleHelp("stop", "Request that one or more Compute Instances stop running."),
      lifecycleHelp("restart", "Request that one or more Compute Instances restart."),
      {
        name: "destroy",
        summary: "Permanently release one or more managed Compute Instances.",
        purpose:
          "Destroy provider resources after EasyServer confirms their managed identity and any relevant connection consequences.",
        usage: ["<instance-id>... [--close-sessions] [--yes]"],
        options: [
          {
            syntax: "--close-sessions",
            description: "Coordinate closure of daemon-owned sessions for the exact destroy target set before dispatch.",
          },
          {
            syntax: "--yes",
            description: "Explicitly authorize the destructive mutation in non-interactive automation.",
          },
        ],
        notes: [
          "Destroy is destructive and may stop billing only according to the target provider's contract. Verify provider semantics before relying on billing behavior.",
        ],
        example:
          "easyserver instances destroy instance:01234567-89ab-cdef-0123-456789abcdef --close-sessions --yes",
      },
      {
        name: "wait",
        summary: "Wait until one Compute Instance reaches a normalized state or disappears.",
        purpose:
          "Observe provider inventory until the target reaches the requested state without redispatching a lifecycle mutation.",
        usage: ["<instance-id> --state <state|absent> [--timeout <seconds>]"],
        options: [
          {
            syntax: "--state <state|absent>",
            description: "Required normalized target state, or absent after a successful destroy.",
          },
          {
            syntax: "--timeout <seconds>",
            description: "Optional observation timeout in seconds.",
          },
        ],
        example:
          "easyserver instances wait instance:01234567-89ab-cdef-0123-456789abcdef --state running --timeout 300",
      },
    ],
  },
  {
    name: "connect",
    summary: "Open a foreground localhost Endpoint to a remote TCP service.",
    purpose:
      "Create a TUI/CLI-process-owned foreground Endpoint on 127.0.0.1. The transport exists only while this command is running and is distinct from daemon-owned persistent Connection Sessions.",
    usage: [
      "<instance-id> --port <remote-port> [--host <remote-host>] [--local-port <local-port>] [--access-method <id>]",
    ],
    options: connectionOptions(false),
    notes: [
      "The local bind is loopback-only. Without --local-port, EasyServer allocates a dynamic local port.",
      "Foreground Endpoint lifetime belongs to this process; use `easyserver sessions create` when the connection must survive CLI/TUI exit.",
    ],
    example:
      "easyserver connect instance:01234567-89ab-cdef-0123-456789abcdef --port 8188 --local-port 54321",
  },
  {
    name: "daemon",
    summary: "Run and control the local daemon that owns persistent Connection Sessions.",
    purpose:
      "Manage the authenticated local EasyServer daemon. Persistent Sessions and Endpoint intents belong to this daemon rather than to a foreground CLI process.",
    children: [
      {
        name: "run",
        summary: "Run the daemon in the current foreground process.",
        purpose: "Start the local daemon without detaching it from the current terminal.",
        usage: [""],
        example: "easyserver daemon run",
      },
      {
        name: "start",
        summary: "Start the managed daemon in the background.",
        purpose: "Launch the supported managed daemon process and wait for its authenticated descriptor to become ready.",
        usage: [""],
        example: "easyserver daemon start",
      },
      {
        name: "status",
        summary: "Inspect managed daemon reachability without changing it.",
        purpose: "Report whether the daemon is stopped, running or unreachable/stale.",
        usage: [""],
        example: "easyserver daemon status",
      },
      {
        name: "stop",
        summary: "Stop the managed daemon after closing daemon-owned live sessions.",
        purpose:
          "Ask the managed daemon to shut down cleanly. Persistent desired Endpoint intents remain durable and can be realized again after restart.",
        usage: [""],
        example: "easyserver daemon stop",
      },
    ],
  },
  {
    name: "sessions",
    summary: "Manage daemon-owned persistent Connection Sessions and Endpoint intents.",
    purpose:
      "Create runtime Connection Sessions that survive TUI/CLI exit, and manage durable Endpoint intents that survive daemon restart and are re-realized when possible.",
    children: [
      {
        name: "create",
        summary: "Create one daemon-owned persistent Connection Session.",
        purpose:
          "Create a persistent localhost Endpoint owned by the daemon rather than the current CLI process.",
        usage: [
          "<instance-id> --port <remote-port> [--host <remote-host>] [--local-port <local-port>] [--access-method <id>] [--idempotency-key <key>]",
        ],
        options: connectionOptions(true),
        notes: [
          "Unknown SSH hosts are not auto-trusted by daemon-owned setup. Enroll trust explicitly through a foreground connection first.",
        ],
        example:
          "easyserver sessions create instance:01234567-89ab-cdef-0123-456789abcdef --port 8188 --idempotency-key comfyui-main",
      },
      {
        name: "list",
        summary: "List daemon-owned runtime Connection Sessions.",
        purpose: "Inspect live, closing and cleanup-failed persistent Sessions by stable Session ID.",
        usage: [""],
        example: "easyserver sessions list",
      },
      {
        name: "close",
        summary: "Close one daemon-owned Connection Session by stable Session ID.",
        purpose:
          "Close the current transport and remove the Session record after cleanup succeeds. Repeating close on a cleanup-failed Session retries cleanup for the same identity.",
        usage: ["<session-id>"],
        example: "easyserver sessions close session:01234567-89ab-cdef-0123-456789abcdef",
      },
      {
        name: "intents",
        summary: "Manage durable desired Endpoint definitions recovered by the daemon.",
        purpose:
          "Endpoint intents preserve desired connection state across daemon restarts. Their current transport realization is runtime state and may be Starting, Live, Error or Disabled.",
        children: [
          {
            name: "list",
            summary: "List persisted Endpoint intents and current realization state.",
            purpose: "Show durable desired connection definitions separately from runtime Connection Sessions.",
            usage: [""],
            example: "easyserver sessions intents list",
          },
          {
            name: "create",
            summary: "Create a named persistent Endpoint intent.",
            purpose:
              "Persist desired Endpoint state and ask the daemon to realize it using the requested target, Access Method and local-port policy.",
            usage: [
              "<name> <instance-id> --port <remote-port> [--host <remote-host>] [--local-port <local-port>] [--access-method <id>]",
            ],
            options: connectionOptions(false),
            example:
              "easyserver sessions intents create comfyui-main instance:01234567-89ab-cdef-0123-456789abcdef --port 8188",
          },
          intentToggleHelp("enable", "Enable a persisted Endpoint intent and allow realization."),
          intentToggleHelp("disable", "Disable a persisted Endpoint intent without deleting its desired definition."),
          intentToggleHelp("retry", "Retry realization of an Endpoint intent currently in Error state."),
          {
            name: "remove",
            summary: "Delete a persisted Endpoint intent and clean its current realization.",
            purpose:
              "Remove the durable desired definition. If it is currently live or starting, the daemon also closes/cancels that exact realization without touching unrelated Sessions or intents.",
            usage: ["<name>"],
            example: "easyserver sessions intents remove comfyui-main",
          },
        ],
      },
    ],
  },
  {
    name: "provider",
    summary: "Discover and run provider-owned feature commands.",
    purpose:
      "Use Provider Plugin features whose acquisition or provider-specific semantics do not belong in the universal EasyServer lifecycle model.",
    usage: ["[<provider-id> [<feature-id> [<command> [--yes] [provider-args...]]]]"],
    notes: [
      "Provider-specific arguments stay provider-owned. Use `easyserver provider <provider-id> <feature-id> <command> --help` for declarative command help when the plugin publishes a side-effect-free help contribution.",
      "Provider mutation commands may declare billable or destructive risk. Non-interactive execution requires explicit --yes when host safety policy demands it.",
    ],
    example: "easyserver provider vastai marketplace search --gpu \"RTX 4090\" --limit 10",
  },
];

const root: CliHelpNode = {
  name: "",
  summary: "Provider-independent compute lifecycle and local connectivity.",
  purpose:
    "EasyServer manages rented compute across Provider Plugins, normalizes lifecycle operations and exposes remote TCP services through local loopback Endpoints.",
  options: [
    {
      syntax: "--json",
      description:
        "Prefix a command with --json to emit the documented versioned machine-readable envelope instead of human display text.",
    },
  ],
  notes: [
    "JSON mode is explicit command mode: use `easyserver --json <command> ...`. The flag is host-owned and must appear before the command, so provider-owned command arguments remain untouched.",
  ],
  children: coreCommands,
};

export function formatCoreHelp(path: readonly string[] = []): string | undefined {
  const node = findExactNode(path);
  return node === undefined ? undefined : formatHelpNode(node, path);
}

export function findContextualHelpPath(args: readonly string[]): readonly string[] {
  let node = root;
  const path: string[] = [];
  for (const part of args) {
    const child = node.children?.find((candidate) => candidate.name === part);
    if (child === undefined) {
      break;
    }
    node = child;
    path.push(part);
  }
  return path;
}

export function formatHelpHint(path: readonly string[]): string {
  return `See: easyserver${path.length === 0 ? "" : ` ${path.join(" ")}`} --help`;
}

function findExactNode(path: readonly string[]): CliHelpNode | undefined {
  let node = root;
  for (const part of path) {
    const child = node.children?.find((candidate) => candidate.name === part);
    if (child === undefined) {
      return undefined;
    }
    node = child;
  }
  return node;
}

function formatHelpNode(node: CliHelpNode, path: readonly string[]): string {
  const commandPath = `easyserver${path.length === 0 ? "" : ` ${path.join(" ")}`}`;
  const lines = [
    path.length === 0 ? "EasyServer" : `EasyServer · ${path.join(" ")}`,
    "",
    node.summary,
    ...(node.purpose === node.summary ? [] : [node.purpose]),
    "",
  ];

  if (path.length === 0) {
    lines.push(
      "Interactive use:",
      "  easyserver                 Open the interactive TUI (interactive terminal required).",
      "",
      "Command/automation use:",
      "  easyserver --help          Show this CLI help entrypoint.",
      "  easyserver --version       Print the EasyServer version without starting the TUI.",
      "  easyserver --json <command> ...  Emit the versioned machine-readable command result.",
    );
  }

  const usage = node.usage ?? (node.children === undefined ? [""] : ["<command> [args...]"]);
  lines.push("", "Usage:");
  for (const suffix of usage) {
    lines.push(`  ${commandPath}${suffix.length === 0 ? "" : ` ${suffix}`}`);
  }

  if ((node.children?.length ?? 0) > 0) {
    lines.push("", "Commands:");
    const width = Math.max(...(node.children ?? []).map((child) => child.name.length));
    for (const child of node.children ?? []) {
      lines.push(`  ${child.name.padEnd(width)}  ${child.summary}`);
    }
    lines.push("", `Run \`${commandPath} <command> --help\` for contextual help.`);
  }

  if ((node.options?.length ?? 0) > 0) {
    lines.push("", "Options:");
    const width = Math.max(...(node.options ?? []).map((option) => option.syntax.length));
    for (const option of node.options ?? []) {
      lines.push(`  ${option.syntax.padEnd(width)}  ${option.description}`);
    }
  }

  if ((node.notes?.length ?? 0) > 0) {
    lines.push("", "Notes:");
    for (const note of node.notes ?? []) {
      lines.push(`  ${note}`);
    }
  }

  if (node.example !== undefined) {
    lines.push("", "Example:", `  ${node.example}`);
  }

  return `${lines.join("\n")}\n`;
}

function lifecycleHelp(name: "start" | "stop" | "restart", purpose: string): CliHelpNode {
  return {
    name,
    summary: purpose,
    purpose,
    usage: ["<instance-id>..."],
    notes: [
      "The command accepts multiple canonical IDs. Each target keeps its own completed, failed, cancelled or outcome-unknown result.",
    ],
    example: `easyserver instances ${name} instance:01234567-89ab-cdef-0123-456789abcdef`,
  };
}

function intentToggleHelp(
  name: "enable" | "disable" | "retry",
  purpose: string,
): CliHelpNode {
  return {
    name,
    summary: purpose,
    purpose,
    usage: ["<name>"],
    example: `easyserver sessions intents ${name} comfyui-main`,
  };
}

function connectionOptions(includeIdempotencyKey: boolean): readonly {
  readonly syntax: string;
  readonly description: string;
}[] {
  return [
    {
      syntax: "--port <remote-port>",
      description: "Required remote TCP port, 1-65535.",
    },
    {
      syntax: "--host <remote-host>",
      description: "Remote host on the instance; defaults to 127.0.0.1.",
    },
    {
      syntax: "--local-port <local-port>",
      description: "Stable loopback port to request; omitted means dynamic allocation.",
    },
    {
      syntax: "--access-method <id>",
      description: "Choose one provider-declared Access Method instead of the deterministic default.",
    },
    ...(includeIdempotencyKey
      ? [
          {
            syntax: "--idempotency-key <key>",
            description: "Stable request identity for retrying persistent Session creation without duplication.",
          },
        ]
      : []),
  ];
}
