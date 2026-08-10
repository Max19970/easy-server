# Install from GitHub Releases

EasyCompute `0.1.0` provides a portable **Windows 11 x64** ZIP on the GitHub Releases page. This is a supported way to obtain and run the CLI without installing `@easycompute/cli` from npm.

The ZIP is not a self-contained native executable. It contains EasyCompute core and its runtime dependencies, but **does not bundle Node.js or any Provider Plugin**.

## Requirements

Install the qualified release runtime first:

- Node.js `24.18.1` available as `node` on `PATH`;
- Windows 11 x64;
- Windows OpenSSH Client (`ssh` and `ssh-keyscan` on `PATH`) when using SSH-backed access.

npm is not required just to run the downloaded core CLI. npm `11.16.0` is needed only if you later choose to install npm-distributed Provider Plugins into the portable bundle.

## Download and verify

Download these two assets from the `v0.1.0` GitHub Release:

```text
easycompute-0.1.0-windows-x64.zip
easycompute-0.1.0-SHA256SUMS.txt
```

Verify the ZIP before extracting it. This uses the .NET SHA-256 implementation available to Windows PowerShell and does not depend on an optional hashing cmdlet:

```powershell
$expected = ((Get-Content .\easycompute-0.1.0-SHA256SUMS.txt) -split '\s+')[0]
$stream = [IO.File]::OpenRead((Resolve-Path .\easycompute-0.1.0-windows-x64.zip))
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
  $actual = ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
} finally {
  $sha256.Dispose()
  $stream.Dispose()
}
if ($actual -ne $expected) { throw 'EasyCompute release checksum mismatch' }
```

## Extract and run

Choose a directory for this version and extract the ZIP into it:

```powershell
$easycompute = Join-Path $PWD 'easycompute-0.1.0-windows-x64'
New-Item -ItemType Directory -Force $easycompute | Out-Null
Expand-Archive .\easycompute-0.1.0-windows-x64.zip -DestinationPath $easycompute -Force
& "$easycompute\easycompute.cmd" --version
& "$easycompute\easycompute.cmd" plugins list
```

The expected version is `0.1.0`, and a fresh bundle reports:

```text
No provider plugins configured.
```

You can keep the bundle anywhere convenient and invoke `easycompute.cmd` by path, or add that directory to your own `PATH` if desired.

## Add a Provider Plugin later

Provider Plugins remain explicit opt-in components. Install a selected plugin into the **same extracted prefix**, then register it with that bundle's CLI:

```powershell
npm install --global --prefix $easycompute @easycompute/plugin-vastai@0.1.0
& "$easycompute\easycompute.cmd" plugins add @easycompute/plugin-vastai
```

Intelion.cloud is equivalent:

```powershell
npm install --global --prefix $easycompute @easycompute/plugin-intelion@0.1.0
& "$easycompute\easycompute.cmd" plugins add @easycompute/plugin-intelion
```

Installing a Provider Plugin this way does not turn it into part of the default GitHub Release artifact; it modifies only your extracted local bundle.

## Update the portable bundle

For a future release, download and verify the new versioned ZIP, extract it into a new versioned directory, and reinstall only the Provider Plugins you want into that new prefix. Do not copy `node_modules` from an older bundle over the new one.

By default, EasyCompute Local State lives under your user profile and credentials live in the OS-backed Secret Store, so they are not stored inside the portable bundle. Custom `EASYCOMPUTE_STATE_FILE` or daemon paths remain the caller's responsibility.

## What is inside the ZIP

The portable artifact contains:

- the `easycompute.cmd` and PowerShell launch shims;
- packed `@easycompute/cli` and `@easycompute/plugin-sdk` packages;
- the CLI's production runtime dependencies, including the qualified Windows keyring binary;
- a short bundle README and the MIT license.

It intentionally does **not** contain:

- Node.js;
- Vast.ai or Intelion.cloud Provider Plugins;
- repository source files, workspace symlinks or development dependencies;
- maintainer/private release state.

Release preparation builds the ZIP from npm-packed release packages, computes SHA-256, extracts the resulting ZIP into a clean directory outside the repository and runs `easycompute.cmd --version`, `--help` and `plugins list` from that extracted copy before the artifact is eligible for attachment to a GitHub Release.
