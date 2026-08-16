# Supported platforms

EasyServer `0.2.x` currently makes one release-level client-platform promise: **Windows 11 x64**.

Other operating systems may run parts of the project, but installability alone is not a support claim. Linux and macOS remain unqualified until their package, Secret Store, terminal, provider, and connection paths are verified to the same standard.

## Supported matrix

| Platform | Architecture | Status | Secret Store | SSH prerequisite |
| --- | --- | --- | --- | --- |
| Windows 11 | x64 | Supported | Windows Credential Manager through EasyServer's OS keyring integration | Windows OpenSSH Client; `ssh` on `PATH` |

Qualified runtime for the `0.2.x` release line:

- Node.js `24.18.1`;
- npm `11.16.0` for npm-based installation and Provider Plugin package installation.

The published package engine range accepts Node.js from `24.18.1` up to, but not including, Node 25. When diagnosing release-specific behavior, use the qualified runtime above before treating another Node version as equivalent evidence.

## Windows OpenSSH

EasyServer's built-in SSH connection path uses the system OpenSSH client rather than embedding an SSH implementation.

Check the client with:

```powershell
ssh -V
```

`ssh-keyscan` is preferred for first-use host-key discovery when available:

```powershell
Get-Command ssh-keyscan
```

If `ssh-keyscan` is missing or cannot negotiate with a particular server, EasyServer can fall back to one bounded, commandless `ssh` handshake against an isolated temporary known-hosts file. That fallback only obtains public host-key evidence for review; it does not create permanent trust.

If `ssh` itself is unavailable, enable/install the Windows OpenSSH Client feature and make sure the executable is reachable through `PATH`.

See [Connections](connections.md#first-use-ssh-host-trust) for the trust flow.

## Secret Store requirement

Provider credentials are kept through the operating-system Secret Store rather than ordinary EasyServer Local State.

On the supported Windows path, EasyServer uses Windows Credential Manager through its keyring integration. A functioning native keyring integration is part of the support contract; a machine where that integration cannot operate is not equivalent to the qualified environment even if the JavaScript package installs successfully.

See the [Security model](security-model.md#provider-credentials-and-secret-store) for the trust boundary.

## npm installation

The primary package path is:

```powershell
npm install --global @easyai101/easyserver
```

Provider Plugins are separate opt-in packages installed into the same package environment. See [Getting started](getting-started.md).

## Portable GitHub Release ZIP

Windows releases also provide:

```text
easyserver-<version>-windows-x64.zip
easyserver-<version>-SHA256SUMS.txt
```

The ZIP contains the core CLI/runtime dependencies but not Node.js or Provider Plugins. It is not a native standalone executable.

Follow [Install from GitHub Releases](github-release-install.md) for checksum verification, extraction, and prefix-aware plugin installation.

## Not supported by the current `0.2.x` contract

The following are not currently release-qualified client targets:

- Linux distributions;
- macOS;
- Windows on ARM64;
- Windows versions other than Windows 11;
- WSL/containers/headless environments as distinct client-platform contracts;
- Node 25 or newer.

“Not supported” does not necessarily mean “known incompatible”. It means the project does not currently promise release-level support for that environment.

Linux/macOS qualification is tracked separately in [GitHub issue #39](https://github.com/Max19970/easy-server/issues/39).
