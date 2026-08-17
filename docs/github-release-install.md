# Install from GitHub Releases

EasyServer publishes a portable Windows x64 ZIP alongside the npm packages. Use it when you want a versioned EasyServer core directory without installing the core package into npm's global prefix.

The ZIP is **not** a standalone native executable. It contains the core CLI and runtime dependencies, but it intentionally contains neither Node.js nor Provider Plugins.

## Requirements

For EasyServer `0.2.1` you need:

- Windows 11 x64;
- Node.js `24.18.1` available as `node` on `PATH`;
- Windows OpenSSH Client when you use SSH-backed connections.

npm is not required just to run the extracted core bundle. It is needed only when you add npm-distributed Provider Plugins to that extracted prefix.

The authoritative current platform boundary is [Supported platforms](supported-platforms.md).

## Download the release assets

From GitHub Release `v0.2.1`, download:

```text
easyserver-0.2.1-windows-x64.zip
easyserver-0.2.1-SHA256SUMS.txt
```

## Verify the checksum

Run this in Windows PowerShell from the directory containing both downloads:

```powershell
$expected = ((Get-Content .\easyserver-0.2.1-SHA256SUMS.txt) -split '\s+')[0]
$stream = [IO.File]::OpenRead((Resolve-Path .\easyserver-0.2.1-windows-x64.zip))
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
  $actual = ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
} finally {
  $sha256.Dispose()
  $stream.Dispose()
}
if ($actual -ne $expected) { throw 'EasyServer release checksum mismatch' }
```

Do not continue with an artifact whose checksum does not match the published file.

## Extract and run EasyServer

Choose a directory for this version:

```powershell
$easyserver = Join-Path $PWD 'easyserver-0.2.1-windows-x64'
New-Item -ItemType Directory -Force $easyserver | Out-Null
Expand-Archive .\easyserver-0.2.1-windows-x64.zip -DestinationPath $easyserver -Force
```

Check the extracted CLI:

```powershell
& "$easyserver\easyserver.cmd" --version
& "$easyserver\easyserver.cmd" plugins list
```

A fresh `0.2.1` bundle reports version `0.2.1` and:

```text
No provider plugins configured.
```

Run the TUI with:

```powershell
& "$easyserver\easyserver.cmd"
```

You can keep the bundle anywhere convenient and invoke it by path or add that directory to your own `PATH`.

## Add a Provider Plugin later

Provider Plugins are opt-in packages. Install them into the **same extracted EasyServer prefix** so that this portable CLI can discover them.

Vast.ai:

```powershell
npm install --global --prefix $easyserver @easyai101/easyserver-plugin-vastai@0.2.1
& "$easyserver\easyserver.cmd" plugins add @easyai101/easyserver-plugin-vastai
```

Intelion.cloud:

```powershell
npm install --global --prefix $easyserver @easyai101/easyserver-plugin-intelion@0.2.1
& "$easyserver\easyserver.cmd" plugins add @easyai101/easyserver-plugin-intelion
```

Then run the portable TUI and configure the provider normally.

Installing a plugin into your ordinary global npm prefix does not make it part of a separate portable EasyServer directory. Likewise, installing a plugin into this prefix changes only this extracted copy; it does not change the original release artifact.

## Update to a newer portable release

Treat each versioned ZIP as its own installation directory:

1. Download the new release ZIP and checksum.
2. Verify the new checksum.
3. Extract into a new versioned directory.
4. Reinstall only the Provider Plugins you want into the new prefix.
5. Start the new version and confirm the configured provider/state behavior you expect.

Do not copy `node_modules` from an older bundle over a newer one.

EasyServer Local State and Secret Store data are normally outside the bundle under your user profile, so extracting a new version does not itself reset them. The [Package lifecycle](package-lifecycle.md) and [Versioning and compatibility](versioning-and-compatibility.md) documents define the supported state-preservation contract.

## What the ZIP contains

The portable artifact contains:

- `easyserver.cmd` and the PowerShell launch shim;
- packed `@easyai101/easyserver` and `@easyai101/easyserver-plugin-sdk` packages;
- the CLI's production runtime dependencies, including the qualified Windows keyring binary;
- a short bundle README and the MIT license.

It intentionally does not contain:

- Node.js;
- Vast.ai or Intelion.cloud Provider Plugins;
- repository source files, workspace symlinks, or development dependencies;
- maintainer/private release state.
