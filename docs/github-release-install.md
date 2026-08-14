# Install from GitHub Releases

EasyServer `0.2.0` provides a portable **Windows 11 x64** ZIP on the GitHub Releases page. This is a supported way to obtain and run the CLI without installing `@easyai101/easyserver` from npm.

The ZIP is not a self-contained native executable. It contains EasyServer core and its runtime dependencies, but **does not bundle Node.js or any Provider Plugin**.

## Requirements

Install the qualified release runtime first:

- Node.js `24.18.1` available as `node` on `PATH`;
- Windows 11 x64;
- Windows OpenSSH Client (`ssh` and `ssh-keyscan` on `PATH`) when using SSH-backed access.

npm is not required just to run the downloaded core CLI. npm `11.16.0` is needed only if you later choose to install npm-distributed Provider Plugins into the portable bundle.

## Download and verify

Download these two assets from the `v0.2.0` GitHub Release:

```text
easyserver-0.2.0-windows-x64.zip
easyserver-0.2.0-SHA256SUMS.txt
```

Verify the ZIP before extracting it. This uses the .NET SHA-256 implementation available to Windows PowerShell and does not depend on an optional hashing cmdlet:

```powershell
$expected = ((Get-Content .\easyserver-0.2.0-SHA256SUMS.txt) -split '\s+')[0]
$stream = [IO.File]::OpenRead((Resolve-Path .\easyserver-0.2.0-windows-x64.zip))
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
  $actual = ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
} finally {
  $sha256.Dispose()
  $stream.Dispose()
}
if ($actual -ne $expected) { throw 'EasyServer release checksum mismatch' }
```

## Extract and run

Choose a directory for this version and extract the ZIP into it:

```powershell
$easyserver = Join-Path $PWD 'easyserver-0.2.0-windows-x64'
New-Item -ItemType Directory -Force $easyserver | Out-Null
Expand-Archive .\easyserver-0.2.0-windows-x64.zip -DestinationPath $easyserver -Force
& "$easyserver\easyserver.cmd" --version
& "$easyserver\easyserver.cmd" plugins list
```

The expected version is `0.2.0`, and a fresh bundle reports:

```text
No provider plugins configured.
```

You can keep the bundle anywhere convenient and invoke `easyserver.cmd` by path, or add that directory to your own `PATH` if desired.

## Add a Provider Plugin later

Provider Plugins remain explicit opt-in components. Install a selected plugin into the **same extracted prefix**, then register it with that bundle's CLI. Release-specific instructions pin the compatible `0.2.0` plugin version so a future npm `latest` cannot silently select an incompatible line:

```powershell
npm install --global --prefix $easyserver @easyai101/easyserver-plugin-vastai@0.2.0
& "$easyserver\easyserver.cmd" plugins add @easyai101/easyserver-plugin-vastai
```

Intelion.cloud is equivalent:

```powershell
npm install --global --prefix $easyserver @easyai101/easyserver-plugin-intelion@0.2.0
& "$easyserver\easyserver.cmd" plugins add @easyai101/easyserver-plugin-intelion
```

Installing a Provider Plugin this way does not turn it into part of the default GitHub Release artifact; it modifies only your extracted local bundle.

## Update the portable bundle

For a future release, download and verify the new versioned ZIP, extract it into a new versioned directory, and reinstall only the Provider Plugins you want into that new prefix. Do not copy `node_modules` from an older bundle over the new one.

By default, EasyServer Local State lives under your user profile and credentials live in the OS-backed Secret Store, so they are not stored inside the portable bundle. Custom `EASYSERVER_STATE_FILE` or daemon paths remain the caller's responsibility.

## What is inside the ZIP

The portable artifact contains:

- the `easyserver.cmd` and PowerShell launch shims;
- packed `@easyai101/easyserver` and `@easyai101/easyserver-plugin-sdk` packages;
- the CLI's production runtime dependencies, including the qualified Windows keyring binary;
- a short bundle README and the MIT license.

It intentionally does **not** contain:

- Node.js;
- Vast.ai or Intelion.cloud Provider Plugins;
- repository source files, workspace symlinks or development dependencies;
- maintainer/private release state.

Release preparation builds the ZIP from npm-packed release packages, computes SHA-256, extracts the resulting ZIP into a clean directory outside the repository and verifies `easyserver.cmd --version`, `--help`, `plugins list` and a real no-argument TUI launch/clean exit from that extracted copy before the artifact is eligible for attachment to a GitHub Release.
