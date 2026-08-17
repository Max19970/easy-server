# Supported platforms

EasyServer's `0.2.x` support matrix is versioned. **EasyServer 0.2.0 was qualified only for Windows 11 x64. Starting with 0.2.1, Ubuntu 24.04 x64 and macOS 15 arm64 join Windows 11 x64 as release-qualified client targets.**

Support is intentionally exact: installability on a nearby operating system or architecture is not treated as equivalent release evidence. The newly qualified Ubuntu and macOS targets are continuously exercised with package installation, the full test gate, a real OS Secret Store round trip, and real system OpenSSH/`ssh-keyscan` prerequisite checks. Windows 11 x64 retains its previously established support contract; its automated release gate continuously covers the full test suite, packaged installation, release artifact, TUI surface, and real OS keyring integration.

## Supported matrix

| Platform | Architecture | Qualified releases | Secret Store | SSH prerequisite |
| --- | --- | --- | --- | --- |
| Windows 11 | x64 | `0.2.0+` | Windows Credential Manager through EasyServer's OS keyring integration | Windows OpenSSH Client; `ssh` on `PATH` |
| Ubuntu 24.04 | x64 | `0.2.1+` | Linux Secret Service when available, with kernel keyutils fallback | System OpenSSH client; `ssh` on `PATH` |
| macOS 15 | arm64 | `0.2.1+` | macOS Keychain through EasyServer's OS keyring integration | System OpenSSH client; `ssh` on `PATH` |

Qualified runtime for the `0.2.x` release line:

- Node.js `24.18.1`;
- npm `11.16.0` for npm-based installation and Provider Plugin package installation.

The published package engine range accepts Node.js from `24.18.1` up to, but not including, Node 25. When diagnosing release-specific behavior, use the qualified runtime above before treating another Node version as equivalent evidence.

## OpenSSH requirement

EasyServer's built-in SSH connection path uses the operating system's OpenSSH client rather than embedding an SSH implementation.

Check the client with:

```text
ssh -V
```

`ssh-keyscan` is preferred for first-use host-key discovery and is present in all three qualified release environments. On Windows PowerShell, for example:

```powershell
Get-Command ssh-keyscan
```

On Ubuntu or macOS:

```sh
command -v ssh-keyscan
```

If `ssh-keyscan` is missing or cannot negotiate with a particular server, EasyServer can fall back to one bounded, commandless `ssh` handshake against an isolated temporary known-hosts file. That fallback only obtains public host-key evidence for review; it does not create permanent trust.

If `ssh` itself is unavailable, install or enable the platform OpenSSH client and make sure the executable is reachable through `PATH`.

See [Connections](connections.md#first-use-ssh-host-trust) for the trust flow.

## Secret Store requirement

Provider credentials are kept through the operating-system Secret Store rather than ordinary EasyServer Local State. A functioning native keyring path is part of the support contract; a machine where credential create/read/delete cannot operate is not equivalent to a qualified environment even if the JavaScript package installs successfully.

The qualified backends are:

- **Windows 11 x64:** Windows Credential Manager;
- **macOS 15 arm64:** macOS Keychain;
- **Ubuntu 24.04 x64:** `@napi-rs/keyring` first attempts a D-Bus Secret Service backend and falls back to the Linux kernel keyring through keyutils when Secret Service is unavailable.

The Ubuntu release gate performs a real create/read/delete Secret Store round trip on the GitHub-hosted Ubuntu 24.04 x64 runner. In a headless Ubuntu 24.04 x64 environment, at least one of those Linux backends must be usable by the EasyServer process. A Secret Service setup needs an accessible D-Bus Secret Service for the user session; otherwise the kernel keyring/keyutils fallback must be available. Containers and WSL remain separate, unqualified client environments because their session, D-Bus, and kernel-keyring behavior can differ from the qualified Ubuntu host.

See the [Security model](security-model.md#provider-credentials-and-secret-store) for the trust boundary.

## npm installation

The primary package path on every qualified platform is:

```text
npm install --global @easyai101/easyserver
```

Provider Plugins are separate opt-in packages installed into the same package environment. See [Getting started](getting-started.md).

## Portable GitHub Release ZIP

The portable GitHub Release ZIP remains a **Windows x64-only** distribution:

```text
easyserver-<version>-windows-x64.zip
easyserver-<version>-SHA256SUMS.txt
```

The ZIP contains the core CLI/runtime dependencies but not Node.js or Provider Plugins. It is not a native standalone executable. Ubuntu and macOS users should use the npm package path above.

Follow [Install from GitHub Releases](github-release-install.md) for checksum verification, extraction, and prefix-aware plugin installation on Windows.

## Not supported by the current `0.2.x` contract

The following are not currently release-qualified client targets:

- Linux distributions or versions other than Ubuntu 24.04 x64;
- macOS versions or architectures other than macOS 15 arm64;
- Windows on ARM64;
- Windows versions other than Windows 11;
- WSL and containers as distinct client-platform contracts;
- Node 25 or newer.

“Not supported” does not necessarily mean “known incompatible”. It means the project does not currently promise release-level support for that environment.
