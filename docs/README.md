# EasyServer documentation

**Languages:** English · [Русский](ru/README.md)

Start with the task you are trying to complete. The documentation intentionally gets more technical as you move from first use into automation, extension, compatibility, and security details.

## Start here

- [Getting started](getting-started.md) — install EasyServer, add a provider, rent a server, and reach the first service on `localhost`.
- [Interactive TUI](tui.md) — navigate the main interface, manage servers, configure providers, recover connection failures, and use accessibility modes.
- [Supported platforms](supported-platforms.md) — check the current operating-system, Node.js, npm, OpenSSH, and Secret Store support boundary.

## Connect to your servers

- [Connect to a remote service](connections.md) — foreground local connections, remote vs local ports, first-use SSH trust, common failures, and advanced connection-method selection.
- [Background connections](background-connections.md) — managed daemon, background Sessions, saved connection intents, idempotency, restart, and recovery.

## Use a provider

- [Vast.ai](providers/vastai.md) — account preparation, marketplace search/rental, lifecycle, connection requirements, and paid-resource cleanup.
- [Intelion.cloud](providers/intelion.md) — account preparation, server configuration/creation, lifecycle, connection behavior, and paid-resource cleanup.

Provider packages are opt-in. A clean EasyServer installation contains no Provider Plugins until you install and add one.

## Install and operate EasyServer

- [Install from GitHub Releases](github-release-install.md) — verify and run the portable Windows ZIP, then add plugins to that extracted installation when needed.
- [Package lifecycle](package-lifecycle.md) — compatible upgrades, reinstalls, missing plugins, uninstall, and clean removal.
- [Support and maintenance](support-and-maintenance.md) — where to report bugs, what information is useful, and what the project currently supports.

## Automate and integrate

- [Machine-readable CLI output](cli-json.md) — the versioned `--json` envelope, exit semantics, provider command data, and non-interactive SSH host-trust flow.
- [Versioning and compatibility](versioning-and-compatibility.md) — public compatibility promises for the `0.x` release lines, Plugin SDK, Local State, and documented CLI behavior.

The built-in command reference is also available directly from the product:

```powershell
easyserver --help
easyserver instances --help
easyserver connect --help
```

Provider-specific command trees expose their own nested help when the installed plugin publishes it.

## Build a Provider Plugin

- [Build a Provider Plugin](plugin-authoring.md) — approachable package-to-working-provider path.
- [Provider Plugin contracts and operational safety](plugin-reference.md) — precise identity, lifecycle, feature, mutation, credential, access, cleanup, trust, and compatibility contracts.
- [`@easyai101/easyserver-plugin-sdk`](../packages/plugin-sdk/README.md) — package-level SDK entry point.
- [Minimal Provider Plugin example](../examples/minimal-provider-plugin/README.md) — small executable example package.

## Security and project policy

- [Documentation localization](localization.md) — canonical language, locale layout, translation rules, and how to add another language.

- [Security model](security-model.md) — trust boundaries, credential handling, SSH host trust, local control-plane protections, and plugin trust assumptions.
- [Security reporting](../SECURITY.md) — how to report vulnerabilities privately.
- [Contributing](../CONTRIBUTING.md) — development setup and contribution workflow.

## Release history

Historical documents describe what shipped or was verified at a particular release. They are not the source of truth for current behavior.

- [EasyServer 0.2.1 release notes](releases/v0.2.1.md)
- [EasyServer 0.2.0 release notes](releases/v0.2.0.md)
- [EasyServer 0.1.0 release notes](releases/v0.1.0.md)
- [EasyServer 0.1.0 dependency and supply-chain audit](releases/v0.1.0-dependency-audit.md)
