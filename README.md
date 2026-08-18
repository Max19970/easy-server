# EasyServer

**Languages:** English · [Русский](README.ru.md)

Rent cloud servers, manage them from one interface, and make remote services available on your own `localhost`.

```text
Rent a server → start your app on it → Connect → 127.0.0.1:<local-port>
```

EasyServer keeps the provider-specific parts where they belong — Vast.ai still has a marketplace and Intelion.cloud still has its own server configurator — then gives the resulting servers one shared place for lifecycle and local access.

The normal human interface is a full-screen terminal UI:

```powershell
easyserver
```

Use the CLI when you need scripting, automation, or advanced controls:

```powershell
easyserver --help
```

## Why EasyServer

- **One workflow after rental.** Start, stop, restart, destroy, inspect, and connect without switching mental models for every provider.
- **Provider-native acquisition.** Plugins keep provider-specific marketplace, image, flavor, pricing, and creation options instead of forcing them into a lossy universal form.
- **Local access without opening public app ports.** A remote service such as `127.0.0.1:8188` can appear locally as `127.0.0.1:54321`.
- **Interactive safety.** Billable/destructive actions and first-use SSH host trust require explicit confirmation.
- **Opt-in providers.** The core installs without provider plugins; add only the providers you want.

EasyServer manages the compute and connection boundary. It does **not** install or configure workloads on the rented machine.

## Install and try it

Starting with EasyServer **0.2.1**, the `0.2.x` line is release-qualified on **Windows 11 x64**, **Ubuntu 24.04 x64**, and **macOS 15 arm64** with **Node.js 24.18.1**. EasyServer `0.2.0` remains historically Windows-only. See [Supported platforms](docs/supported-platforms.md) for the exact support boundary and Secret Store prerequisites.

Install the core CLI and one provider plugin:

```powershell
npm install --global @easyai101/easyserver
npm install --global @easyai101/easyserver-plugin-vastai
# or: npm install --global @easyai101/easyserver-plugin-intelion
```

Then run:

```powershell
easyserver
```

From the TUI:

1. Open **Settings & Support → Providers** and add the installed provider.
2. Configure its credential.
3. Choose **Rent a server** and complete the provider's guided flow.
4. Open the server, choose **Connect**, and enter the application/service port running on that server.
5. Review the SSH fingerprint on first use, then use the local address EasyServer gives you.

For example, if ComfyUI is listening on the server at `127.0.0.1:8188`, EasyServer may expose it as:

```text
http://127.0.0.1:54321
```

ComfyUI is only an example: EasyServer forwards arbitrary TCP services and does not manage the application itself.

Want the full first-run walkthrough? Start with [Getting started](docs/getting-started.md).

## Supported providers

EasyServer has independently versioned first-party Provider Plugins for:

- **Vast.ai** — marketplace search and rental, lifecycle, and SSH-backed access. [Vast.ai plugin](https://github.com/Max19970/easy-server-plugin-vastai) · [guide](docs/providers/vastai.md)
- **Intelion.cloud** — server catalog/configuration, creation, lifecycle, and SSH-backed access. [Intelion.cloud plugin](https://github.com/Max19970/easy-server-plugin-intelion) · [guide](docs/providers/intelion.md)

These plugins are maintained and released in their own repositories. Their package versions do not need to match the EasyServer version; compatibility is declared through the Provider Plugin host/SDK ranges.

Third-party providers can integrate through the public [`@easyai101/easyserver-plugin-sdk`](packages/plugin-sdk/README.md).

## npm or portable ZIP

The npm packages are the primary ecosystem path. Windows users can also run the core CLI from the versioned GitHub Release ZIP without installing the core package globally.

The portable ZIP still requires Node.js and intentionally contains no provider plugins. Follow [Install from GitHub Releases](docs/github-release-install.md) for checksum verification and prefix-aware plugin installation.

## CLI example

The same basic flow is available without the TUI. Provider acquisition remains provider-specific; server management and connection become shared afterward:

```powershell
easyserver instances list
easyserver connect <instance-id> --port 8188
```

`connect` prints a local loopback address and owns it until the foreground command exits. See [Connect to a remote service](docs/connections.md) for port semantics, SSH trust, recovery, and advanced method selection.

For connections that should survive the current terminal or be restored after daemon restart, see [Background connections](docs/background-connections.md).

## Documentation

Choose the path that matches what you are trying to do:

- **New to EasyServer:** [Getting started](docs/getting-started.md)
- **Using the interactive UI:** [Interactive TUI](docs/tui.md)
- **Connecting to a remote service:** [Connections](docs/connections.md)
- **Keeping connections in the background:** [Background connections](docs/background-connections.md)
- **Using Vast.ai:** [Vast.ai guide](docs/providers/vastai.md)
- **Using Intelion.cloud:** [Intelion.cloud guide](docs/providers/intelion.md)
- **Automating the CLI:** [Machine-readable CLI output](docs/cli-json.md)
- **Writing a Provider Plugin:** [Plugin SDK](packages/plugin-sdk/README.md)
- **Looking for all guides/reference:** [Documentation index](docs/README.md)
- **Reading or contributing translations:** [Documentation localization](docs/localization.md)

Security issues should follow [SECURITY.md](SECURITY.md). Ordinary bugs and support questions are covered by the [support and maintenance policy](docs/support-and-maintenance.md).

## License

EasyServer is released under the [MIT License](LICENSE).
