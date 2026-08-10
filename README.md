# EasyCompute

EasyCompute is a provider-independent control plane for rented compute: one CLI for acquiring provider resources, managing their normalized lifecycle and exposing arbitrary remote TCP services through local loopback Endpoints. It owns the compute resource and connectivity boundary — not the workload running on the machine.

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
  └─ Provider Access Method → Access Adapter → local EasyCompute Endpoint
                                              127.0.0.1:<dynamic-port>
```

That separation is intentional. Vast.ai searches/rents marketplace offers; Intelion.cloud configures servers from its own catalogs. EasyCompute does not pretend those workflows share one universal provisioning request. Once a resource exists, both converge on the same inventory, lifecycle and local-access model.

## What EasyCompute is for

Use EasyCompute when you want provider-independent lifecycle and connectivity around rented compute while keeping provider-specific product concepts in plugins. GPU/AI machines are one use case, but the model is equally applicable to development boxes, game servers, databases, CI workers and arbitrary remote services.

EasyCompute `0.1.0` ships first-party Provider Plugins for:

- **Vast.ai** — marketplace search/rental plus normalized instance lifecycle/access;
- **Intelion.cloud** — flavor/image/SSH-key catalog discovery, server configuration/creation and normalized lifecycle/access.

Third-party providers can integrate through the public [`@easycompute/plugin-sdk`](packages/plugin-sdk/README.md) without adding provider branches to core.

## Supported release environment

EasyCompute `0.1.0` is release-qualified for **Windows 11 x64**, using **Node.js 24.18.1** and **npm 11.16.0**. SSH-backed access additionally requires the Windows OpenSSH Client (`ssh` and `ssh-keyscan` on `PATH`).

Linux and macOS are not part of the `0.1.0` support contract yet; that means unqualified, not necessarily known-incompatible. See [Supported platforms](docs/supported-platforms.md) for the exact qualification boundary.

## Install

EasyCompute `0.1.0` supports two CLI distribution paths on Windows 11 x64.

**npm** is the primary package/ecosystem path:

```powershell
npm install --global @easycompute/cli
```

**GitHub Releases** also provide a versioned portable ZIP, so obtaining the core CLI does not require installing `@easycompute/cli` from npm. The ZIP requires Node.js `24.18.1` on `PATH`, includes no Provider Plugins and is verified with a published SHA-256 checksum. See [Install from GitHub Releases](docs/github-release-install.md).

Both default installations contain **zero Provider Plugins**.

If you installed the CLI globally from npm, install only the providers you want into that same global npm environment:

```powershell
npm install --global @easycompute/plugin-vastai
easycompute plugins add @easycompute/plugin-vastai
```

or:

```powershell
npm install --global @easycompute/plugin-intelion
easycompute plugins add @easycompute/plugin-intelion
```

If you use the portable GitHub Release ZIP, install Provider Plugins into the extracted EasyCompute prefix instead of npm's ordinary global prefix. The exact `--prefix` commands are in [Install from GitHub Releases](docs/github-release-install.md#add-a-provider-plugin-later).

Check the active plugin set:

```powershell
easycompute plugins list
```

## Quick start: rent compute and expose a service

The shortest real flow is provider-specific acquisition followed by provider-independent access. This example uses Vast.ai; prepare the account/API key and register an account-level SSH public key first as described in the [Vast.ai guide](docs/providers/vastai.md).

Import the API key into the OS-backed Secret Store:

```powershell
$env:VAST_API_KEY = '<your-api-key>'
easycompute plugins credential set @easycompute/plugin-vastai api-key --env VAST_API_KEY
Remove-Item Env:VAST_API_KEY
```

Search rentable offers and rent one:

```powershell
easycompute provider vastai marketplace search --gpu "RTX 4090" --min-gpus 1 --verified --limit 10
easycompute provider vastai marketplace rent <offer-id> --image <image> --runtype ssh
```

Find the resulting EasyCompute instance:

```powershell
easycompute instances list
easycompute instances inspect <instance-id>
```

Suppose a workload such as ComfyUI is listening on the rented machine at `127.0.0.1:8188`. Expose that remote TCP target locally:

```powershell
easycompute connect <instance-id> --port 8188
```

EasyCompute prints a dynamically allocated loopback address such as:

```text
127.0.0.1:54321
```

Open `http://127.0.0.1:54321` locally while the command remains active. **ComfyUI is only an example workload**: EasyCompute is forwarding generic TCP bytes and does not know or manage ComfyUI itself. `0.1.0` also does not provide HTTP path routing such as `/comfyui`.

On the first SSH-backed connection, EasyCompute shows the discovered host-key fingerprint and requires explicit trust confirmation before enrolling it. Changed trusted keys fail closed.

For daemon-owned persistent forwarding:

```powershell
easycompute daemon run
```

Then, from another terminal:

```powershell
easycompute sessions create <instance-id> --port 8188
easycompute sessions list
easycompute sessions close <session-id>
```

When a paid resource is no longer needed, close its sessions and use the provider-supported destructive lifecycle operation rather than merely disabling the plugin:

```powershell
easycompute instances destroy <instance-id>
easycompute instances list
```

Provider billing semantics remain provider-specific; `stopped` does not universally mean `not billed`.

## Core commands

```text
easycompute plugins ...                 install-state / credentials / enable-disable
easycompute provider ...                provider-specific acquisition/features
easycompute instances list|inspect ...  normalized inventory
easycompute instances start|stop|restart|destroy ...
easycompute connect ...                 foreground local Endpoint
easycompute daemon run                  local session owner
easycompute sessions create|list|close ...
```

Run `easycompute --help` for the exact command surface.

## What EasyCompute deliberately does not do

EasyCompute is **not** a workload orchestrator. It does not install, deploy, schedule or configure applications on the rented machine; it does not define a universal job/workload specification; and it does not turn provider-specific marketplaces/configurators into one lossy provisioning schema.

It also is not a general reverse proxy or VPN product. The `0.1.0` caller-facing connectivity primitive is an EasyCompute-owned local TCP Endpoint backed by an applicable provider Access Method and Access Adapter.

Provider Plugins run in-process and are trusted extensions in `0.1.0`; the plugin boundary validates contracts and isolates ordinary failures, but is not a malicious-code sandbox.

## Documentation

- [Getting started](docs/getting-started.md)
- [Vast.ai quick start](docs/providers/vastai.md)
- [Intelion.cloud quick start](docs/providers/intelion.md)
- [Supported platforms](docs/supported-platforms.md)
- [Security model](docs/security-model.md)
- [Provider Plugin authoring and operational safety](docs/plugin-authoring-and-operational-safety.md)
- [Versioning and compatibility](docs/versioning-and-compatibility.md)

For contributing, see [CONTRIBUTING.md](CONTRIBUTING.md). Security issues should follow [SECURITY.md](SECURITY.md) rather than a public issue.

## License

EasyCompute is released under the [MIT License](LICENSE).
