# EasyServer

EasyServer is a provider-independent control plane for rented compute: an interactive TUI plus an automation-oriented CLI for acquiring provider resources, managing their normalized lifecycle and exposing arbitrary remote TCP services through local loopback Endpoints. It owns the compute resource and connectivity boundary — not the workload running on the machine.

```text
Provider
  │
  ├─ provider-specific Acquisition Flow
  │      Vast.ai marketplace / Intelion.cloud configurator / ...
  ▼
Compute Instance
  │
  ├─ normalized lifecycle: start / stop / restart / destroy
  │
  └─ Provider Access Method → Access Adapter → local EasyServer Endpoint
                                             127.0.0.1:<dynamic-port>
```

That separation is intentional. Vast.ai searches/rents marketplace offers; Intelion.cloud configures servers from its own catalogs. EasyServer does not pretend those workflows share one universal provisioning request. Once a resource exists, both converge on the same inventory, lifecycle and local-access model.

## What EasyServer is for

Use EasyServer when you want provider-independent lifecycle and connectivity around rented compute while keeping provider-specific product concepts in plugins. GPU/AI machines are one use case, but the model is equally applicable to development boxes, game servers, databases, CI workers and arbitrary remote services.

EasyServer `0.1.0` ships first-party Provider Plugins for:

- **Vast.ai** — marketplace search/rental plus normalized instance lifecycle/access;
- **Intelion.cloud** — flavor/image/SSH-key catalog discovery, server configuration/creation and normalized lifecycle/access.

Third-party providers can integrate through the public [`@easyai101/easyserver-plugin-sdk`](packages/plugin-sdk/README.md) without adding provider branches to core.

## Supported release environment

EasyServer `0.1.0` is release-qualified for **Windows 11 x64**, using **Node.js 24.18.1** and **npm 11.16.0**. SSH-backed access additionally requires the Windows OpenSSH Client (`ssh` and `ssh-keyscan` on `PATH`).

Linux and macOS are not part of the `0.1.0` support contract yet; that means unqualified, not necessarily known-incompatible. See [Supported platforms](docs/supported-platforms.md) for the exact qualification boundary.

## Install

EasyServer `0.1.0` supports two CLI distribution paths on Windows 11 x64.

**npm** is the primary package/ecosystem path:

```powershell
npm install --global @easyai101/easyserver
```

**GitHub Releases** also provide a versioned portable ZIP, so obtaining the core CLI does not require installing `@easyai101/easyserver` from npm. The ZIP requires Node.js `24.18.1` on `PATH`, includes no Provider Plugins and is verified with a published SHA-256 checksum. See [Install from GitHub Releases](docs/github-release-install.md).

Both default installations contain **zero Provider Plugins**.

If you installed the CLI globally from npm, install only the providers you want into that same global npm environment:

```powershell
npm install --global @easyai101/easyserver-plugin-vastai
easyserver plugins add @easyai101/easyserver-plugin-vastai
```

or:

```powershell
npm install --global @easyai101/easyserver-plugin-intelion
easyserver plugins add @easyai101/easyserver-plugin-intelion
```

If you use the portable GitHub Release ZIP, install Provider Plugins into the extracted EasyServer prefix instead of npm's ordinary global prefix. The exact `--prefix` commands are in [Install from GitHub Releases](docs/github-release-install.md#add-a-provider-plugin-later).

Check the active plugin set:

```powershell
easyserver plugins list
```

## Quick start: rent compute and expose a service

The shortest real flow is provider-specific acquisition followed by provider-independent access. This example uses Vast.ai; prepare the account/API key and register an account-level SSH public key first as described in the [Vast.ai guide](docs/providers/vastai.md).

Import the API key into the OS-backed Secret Store:

```powershell
$env:VAST_API_KEY = '<your-api-key>'
easyserver plugins credential set @easyai101/easyserver-plugin-vastai api-key --env VAST_API_KEY
Remove-Item Env:VAST_API_KEY
```

Search rentable offers and rent one:

```powershell
easyserver provider vastai marketplace search --gpu "RTX 4090" --min-gpus 1 --verified --limit 10
easyserver provider vastai marketplace rent <offer-id> --image <image> --runtype ssh
```

Find the resulting EasyServer instance:

```powershell
easyserver instances list
easyserver instances inspect <instance-id>
```

Suppose a workload such as ComfyUI is listening on the rented machine at `127.0.0.1:8188`. Expose that remote TCP target locally:

```powershell
easyserver connect <instance-id> --port 8188
```

EasyServer prints a dynamically allocated loopback address such as:

```text
127.0.0.1:54321
```

Open `http://127.0.0.1:54321` locally while the command remains active. **ComfyUI is only an example workload**: EasyServer is forwarding generic TCP bytes and does not know or manage ComfyUI itself. `0.1.0` also does not provide HTTP path routing such as `/comfyui`.

On the first SSH-backed connection, EasyServer shows the discovered host-key fingerprint and requires explicit trust confirmation before enrolling it. Changed trusted keys fail closed.

For daemon-owned persistent forwarding:

```powershell
easyserver daemon run
```

Then, from another terminal:

```powershell
easyserver sessions create <instance-id> --port 8188
easyserver sessions list
easyserver sessions close <session-id>
```

When a paid resource is no longer needed, close its sessions and use the provider-supported destructive lifecycle operation rather than merely disabling the plugin:

```powershell
easyserver instances destroy <instance-id>
easyserver instances list
```

Provider billing semantics remain provider-specific; `stopped` does not universally mean `not billed`.

## Core commands

Plain `easyserver` is the preferred interactive entrypoint. `easyserver --help` opens the descriptive command-mode hierarchy; every core group and command has its own contextual `--help` page.

```text
easyserver                             interactive TUI
easyserver --help                      CLI/automation help entrypoint
easyserver plugins ...                 install-state / credentials / enable-disable
easyserver provider ...                provider-specific acquisition/features
easyserver instances list|inspect ...  normalized inventory
easyserver instances start|stop|restart|destroy ...
easyserver connect ...                 foreground local Endpoint
easyserver daemon run                  local session owner
easyserver sessions create|list|close ...
```

Run `easyserver --help` for the command groups, then append `--help` to the relevant path (for example `easyserver instances destroy --help`). Package-based Provider Plugins may also publish side-effect-free provider-specific help through their dedicated `./easyserver-help` contribution.

## What EasyServer deliberately does not do

EasyServer is **not** a workload orchestrator. It does not install, deploy, schedule or configure applications on the rented machine; it does not define a universal job/workload specification; and it does not turn provider-specific marketplaces/configurators into one lossy provisioning schema.

It also is not a general reverse proxy or VPN product. The `0.1.0` caller-facing connectivity primitive is an EasyServer-owned local TCP Endpoint backed by an applicable provider Access Method and Access Adapter.

Provider Plugins run in-process and are trusted extensions in `0.1.0`; the plugin boundary validates contracts and isolates ordinary failures, but is not a malicious-code sandbox.

## Documentation

- [Getting started](docs/getting-started.md)
- [Vast.ai quick start](docs/providers/vastai.md)
- [Intelion.cloud quick start](docs/providers/intelion.md)
- [Supported platforms](docs/supported-platforms.md)
- [Security model](docs/security-model.md)
- [Provider Plugin authoring and operational safety](docs/plugin-authoring-and-operational-safety.md)
- [Versioning and compatibility](docs/versioning-and-compatibility.md)
- [Contributing](CONTRIBUTING.md)
- [Support and maintenance policy](docs/support-and-maintenance.md)

For ordinary bugs and provider regressions, open a public GitHub issue using the guidance in the support policy. Security issues should follow [SECURITY.md](SECURITY.md) rather than a public issue.

## License

EasyServer is released under the [MIT License](LICENSE).
