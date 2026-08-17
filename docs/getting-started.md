# Getting started

This guide takes you from a clean EasyServer install to one useful result: a service running on a rented server is reachable on your own `localhost`.

You do not need to learn EasyServer's daemon, saved connection model, internal IDs, or plugin contracts first. Those are available in deeper guides when you need them.

## Before you begin

EasyServer `0.2.0` is qualified for **Windows 11 x64**. Starting with `0.2.1`, the qualified client targets are **Windows 11 x64**, **Ubuntu 24.04 x64**, and **macOS 15 arm64**, with **Node.js 24.18.1**. SSH-backed connections use the system OpenSSH client.

Check the full requirements in [Supported platforms](supported-platforms.md) if your environment differs from the qualified release setup.

You also need an account and credential for at least one supported provider:

- [Vast.ai](providers/vastai.md)
- [Intelion.cloud](providers/intelion.md)

## 1. Install EasyServer

Install the core CLI:

```powershell
npm install --global @easyai101/easyserver
```

Then install one provider plugin. For Vast.ai:

```powershell
npm install --global @easyai101/easyserver-plugin-vastai
```

Or for Intelion.cloud:

```powershell
npm install --global @easyai101/easyserver-plugin-intelion
```

A clean core install contains no providers by default. If you prefer the portable Windows ZIP instead of a global core install, follow [Install from GitHub Releases](github-release-install.md); plugins must be installed into that extracted EasyServer prefix.

## 2. Open the TUI

Run EasyServer with no arguments:

```powershell
easyserver
```

Plain `easyserver` is the normal interactive entry point. The CLI remains available for automation and advanced workflows through `easyserver --help`.

If this is your first run, the useful path is:

**Settings & Support → Providers → Add installed provider**

Choose the provider you installed. EasyServer reads the package's provider metadata so you can select it by name instead of typing a module path.

## 3. Configure the provider credential

Open the provider's **Actions** and choose the credential setup action. The TUI masks the value while you enter it.

EasyServer stores provider credentials through the operating-system Secret Store; normal Local State keeps only an opaque reference to the secret.

Credential names differ by provider:

- Vast.ai: `api-key`
- Intelion.cloud: `api-token`

The provider-specific guides explain where the credential comes from and any account preparation that should happen before rental.

If you are automating setup instead of using the TUI, the equivalent CLI workflow imports a value from an environment variable. See the provider guide for exact commands.

## 4. Rent a server

Return to **Home** and choose **Rent a server**.

Select your provider and follow its guided form. EasyServer deliberately keeps acquisition provider-specific:

- Vast.ai exposes its marketplace and rental options.
- Intelion.cloud exposes its server configuration/catalog flow.

The TUI shows the provider's actual options instead of pretending both services share one generic create form. Billable operations show a confirmation screen before dispatch.

For details about images, GPU filters, flavors, disk settings, SSH account preparation, or provider billing semantics, use the matching provider guide rather than guessing values:

- [Rent with Vast.ai](providers/vastai.md)
- [Create with Intelion.cloud](providers/intelion.md)

## 5. Wait until the server is usable

Open **Servers** and select the server you just created or rented.

Provider state may take time to converge. Use the lifecycle actions EasyServer actually shows for the current server instead of assuming every action is valid in every state.

When the workload you want to reach is running on the server, note its TCP port. For example, ComfyUI commonly listens on port `8188`.

EasyServer does not install or start that workload for you; it manages the compute and connection boundary around it.

## 6. Connect the service to localhost

Select the server and choose **Connect**.

Enter the **application/service port on the server** — for example `8188`. The normal flow can choose a local port automatically.

On the first SSH-backed connection, EasyServer shows the server's SSH host-key fingerprint. Review it and explicitly choose **Trust** if it matches the server you expect. EasyServer keeps its own SSH trust store; trust accepted by a separate `ssh` command is not imported automatically.

When the connection opens, EasyServer gives you a local address such as:

```text
127.0.0.1:54321
```

If the remote service speaks HTTP, open that address in your browser. For the ComfyUI example:

```text
http://127.0.0.1:54321
```

You now have the core EasyServer workflow working end to end: provider-native rental, shared server management, and local access to a remote service.

## If the first connection fails

EasyServer separates common failure layers so you do not have to treat every failure as “the server is unavailable”. The TUI can distinguish cases such as:

- SSH host trust still needs review;
- the SSH login key/password is rejected;
- the SSH route forbids TCP forwarding;
- SSH works but the application/service port is not listening or cannot be reached;
- the requested local port is already occupied.

Use the recovery action the TUI presents — for example **Review SSH fingerprint**, **Edit service port**, **Edit local port**, **Retry connection**, or **Open Diagnostics**.

For the complete connection model and CLI equivalents, see [Connect to a remote service](connections.md).

## Before you leave a paid server running

Closing EasyServer or disabling a provider plugin does **not** destroy the provider resource. A stopped server also does not universally mean billing has ended.

When the server is no longer needed, follow the provider guide's cleanup section and verify the provider resource reaches the intended terminal/absent state:

- [Vast.ai cleanup](providers/vastai.md)
- [Intelion.cloud cleanup](providers/intelion.md)

## Where to go next

- [Interactive TUI](tui.md) — navigation, provider setup, lifecycle, diagnostics, accessibility, and recovery.
- [Connections](connections.md) — foreground connections, ports, SSH trust, advanced method selection, and troubleshooting.
- [Background connections](background-connections.md) — daemon-managed Sessions and saved connection intents.
- [Machine-readable CLI output](cli-json.md) — automation contract and structured errors.
- [Documentation index](README.md) — every public guide and reference surface.
