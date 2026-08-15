# Supported platforms

EasyServer `0.2.0` makes a deliberately narrow platform promise: **Windows 11 x64**.

The codebase and native dependencies may run on additional operating systems, but installation success alone is not a support claim. A platform is supported only after clean installation, deterministic release checks, packaged plugin loading, real OS Secret Store integration and representative access behavior have been qualified together.

## 0.2.0 supported matrix

| Platform | Architecture | Status | Secret Store | SSH access prerequisite |
| --- | --- | --- | --- | --- |
| Windows 11 | x64 | Supported | Windows Credential Manager through the OS keyring integration | Windows OpenSSH Client: `ssh` and `ssh-keyscan` on `PATH` |

Runtime line:

- Node.js `24.18.1`;
- npm `11.16.0` for npm-based installation and Provider Plugin package installation.

The supported GitHub Release download for this platform is `easyserver-<version>-windows-x64.zip`. It is a portable core-CLI bundle rather than a native executable: Node.js is required on `PATH`, while npm is not required merely to run the extracted core bundle. Every release ZIP is paired with `easyserver-<version>-SHA256SUMS.txt` and verified after clean extraction outside the repository before release.

The npm package `engines` ranges accept the Node 24 line from `24.18.1` up to, but not including, Node 25. The release itself is built and continuously verified with the exact runtime versions above; use those versions when diagnosing release-specific behavior.

## What is qualified on Windows

The release verification covers:

- clean `npm ci`, typechecking, build and deterministic test suites;
- packed CLI/Plugin SDK/first-party Provider Plugin artifacts;
- a global npm installation with a working `easyserver` executable and real no-argument TUI launch;
- a portable GitHub Release ZIP built from packed core packages, checksum verification and a clean extracted-bundle TUI smoke test;
- real Windows terminal qualification for normal quit, Ctrl+C, thrown-error cleanup, narrow/wide rendering, resize, `NO_COLOR` and screen-reader mode;
- the default zero-Provider-Plugin installation and explicit plugin installation/loading;
- Local State persistence and atomic updates;
- a real create/read/delete round trip through the OS keyring adapter;
- Provider Plugin lifecycle/feature contracts;
- generic SSH Access Adapter behavior, host-trust handling and local Endpoint/session cleanup;
- real-account first-party Provider acceptance on a Windows 11 x64 client before release.

Real provider acceptance is a maintainer release check and intentionally does not run in ordinary public pull-request CI because it would require provider credentials and potentially paid compute resources.

## OpenSSH prerequisite

EasyServer `0.2.0` uses the production OpenSSH command-line tools for its generic SSH access path rather than embedding an SSH implementation.

Before using an SSH-backed Provider Access Method, verify:

```powershell
ssh -V
Get-Command ssh-keyscan
```

If either command is unavailable, install/enable the Windows OpenSSH Client feature and make sure the executables are reachable through `PATH`.

EasyServer manages its own known-host trust file and fails closed on a changed trusted key. On first foreground access it can show the discovered fingerprint and ask for explicit confirmation; non-interactive daemon setup never auto-trusts an unknown host.

## Not supported by the 0.2.0 contract

The following are **not qualified support targets for 0.2.0**:

- Linux distributions;
- macOS;
- Windows on ARM64;
- Windows versions other than Windows 11;
- containers/WSL/headless environments as a distinct client platform contract;
- Node 25 or newer.

During pre-release qualification, Windows completed the release gate and real OS-keyring probe. Ubuntu and macOS GitHub runners did not complete the same release gate reliably enough to justify a support claim. The follow-up work is tracked separately rather than weakening the meaning of “supported”.

An unsupported platform is not necessarily known to be incompatible; it means EasyServer `0.2.0` does not promise release-level support for it.

## Future platform expansion

Additional platforms should be added only after the full platform smoke is reproducible: clean package install, CLI startup, Local State, real Secret Store, plugin loading and applicable access/cleanup behavior. Linux also needs an explicit supported Secret Service/keyring prerequisite instead of assuming every headless machine has a desktop credential service.
