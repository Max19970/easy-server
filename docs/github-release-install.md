# Install from GitHub Releases

Starting with EasyServer `0.2.2`, every release-qualified client target has a verified portable GitHub Release artifact. Use this path when you want a versioned EasyServer core directory without installing the core package into npm's ordinary global prefix.

Portable artifacts are **not** standalone native executables. They contain the EasyServer CLI and production runtime dependencies, but intentionally contain neither Node.js nor Provider Plugins.

## Requirements

Use the artifact that matches an officially qualified target:

| Platform | Artifact |
| --- | --- |
| Windows 11 x64 | `easyserver-<version>-windows-x64.zip` |
| Ubuntu 24.04 x64 | `easyserver-<version>-linux-x64.tar.gz` |
| macOS 15 arm64 | `easyserver-<version>-macos-arm64.tar.gz` |

Every portable installation requires:

- Node.js `24.18.1` available as `node` on `PATH`;
- the platform OpenSSH client when you use SSH-backed connections;
- npm `11.16.0` only when you want to add npm-distributed Provider Plugins to the extracted prefix.

The authoritative platform and Secret Store boundary is [Supported platforms](supported-platforms.md).

## Download the release assets

For release `v0.2.2`, download the artifact for your platform plus the common checksum manifest:

```text
easyserver-0.2.2-windows-x64.zip
easyserver-0.2.2-linux-x64.tar.gz
easyserver-0.2.2-macos-arm64.tar.gz
easyserver-0.2.2-SHA256SUMS.txt
```

The checksum manifest contains one SHA-256 entry for every portable artifact.

## Verify the checksum

### Windows

Run this in Windows PowerShell from the directory containing the ZIP and checksum manifest:

```powershell
$artifact = 'easyserver-0.2.2-windows-x64.zip'
$line = Get-Content .\easyserver-0.2.2-SHA256SUMS.txt |
  Where-Object { $_ -match "  $([regex]::Escape($artifact))$" } |
  Select-Object -Single
if (-not $line) { throw 'EasyServer release checksum entry is missing' }
$expected = ($line -split '\s+')[0]
$stream = [IO.File]::OpenRead((Resolve-Path $artifact))
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
  $actual = ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
} finally {
  $sha256.Dispose()
  $stream.Dispose()
}
if ($actual -ne $expected) { throw 'EasyServer release checksum mismatch' }
```

### Ubuntu

```sh
artifact='easyserver-0.2.2-linux-x64.tar.gz'
grep "  $artifact$" easyserver-0.2.2-SHA256SUMS.txt | sha256sum --check -
```

### macOS

```sh
artifact='easyserver-0.2.2-macos-arm64.tar.gz'
expected=$(awk -v name="$artifact" '$2 == name { print $1 }' easyserver-0.2.2-SHA256SUMS.txt)
actual=$(shasum -a 256 "$artifact" | awk '{ print $1 }')
[ -n "$expected" ] && [ "$actual" = "$expected" ] || { echo 'EasyServer release checksum mismatch' >&2; exit 1; }
```

Do not continue with an artifact whose checksum does not match the published manifest.

## Extract and run EasyServer

### Windows

```powershell
$easyserver = Join-Path $PWD 'easyserver-0.2.2-windows-x64'
New-Item -ItemType Directory -Force $easyserver | Out-Null
Expand-Archive .\easyserver-0.2.2-windows-x64.zip -DestinationPath $easyserver -Force
& "$easyserver\easyserver.cmd" --version
& "$easyserver\easyserver.cmd" plugins list
```

Run the TUI with:

```powershell
& "$easyserver\easyserver.cmd"
```

### Ubuntu

```sh
easyserver="$PWD/easyserver-0.2.2-linux-x64"
mkdir -p "$easyserver"
tar -xzf easyserver-0.2.2-linux-x64.tar.gz -C "$easyserver"
"$easyserver/bin/easyserver" --version
"$easyserver/bin/easyserver" plugins list
```

Run the TUI with:

```sh
"$easyserver/bin/easyserver"
```

### macOS

```sh
easyserver="$PWD/easyserver-0.2.2-macos-arm64"
mkdir -p "$easyserver"
tar -xzf easyserver-0.2.2-macos-arm64.tar.gz -C "$easyserver"
"$easyserver/bin/easyserver" --version
"$easyserver/bin/easyserver" plugins list
```

Run the TUI with:

```sh
"$easyserver/bin/easyserver"
```

A fresh `0.2.2` bundle on every platform reports version `0.2.2` and:

```text
No provider plugins configured.
```

You can keep the extracted bundle anywhere convenient and invoke it by path or add its launcher directory to your own `PATH`.

## Add a Provider Plugin later

Provider Plugins are opt-in packages. Install them into the **same extracted EasyServer prefix** so that this portable CLI can discover them.

### Windows

Vast.ai:

```powershell
npm install --global --prefix $easyserver @easyai101/easyserver-plugin-vastai@0.2.2
& "$easyserver\easyserver.cmd" plugins add @easyai101/easyserver-plugin-vastai
```

Intelion.cloud:

```powershell
npm install --global --prefix $easyserver @easyai101/easyserver-plugin-intelion@0.2.2
& "$easyserver\easyserver.cmd" plugins add @easyai101/easyserver-plugin-intelion
```

### Ubuntu and macOS

Vast.ai:

```sh
npm install --global --prefix "$easyserver" @easyai101/easyserver-plugin-vastai@0.2.2
"$easyserver/bin/easyserver" plugins add @easyai101/easyserver-plugin-vastai
```

Intelion.cloud:

```sh
npm install --global --prefix "$easyserver" @easyai101/easyserver-plugin-intelion@0.2.2
"$easyserver/bin/easyserver" plugins add @easyai101/easyserver-plugin-intelion
```

Then start the portable TUI and configure the provider normally.

Installing a plugin into your ordinary global npm prefix does not make it part of a separate portable EasyServer directory. Likewise, installing a plugin into an extracted prefix changes only that extracted copy; it does not change the original release artifact.

## Update to a newer portable release

Treat each versioned artifact as its own installation directory:

1. Download the new platform artifact and checksum manifest.
2. Verify the new artifact checksum.
3. Extract into a new versioned directory.
4. Reinstall only the Provider Plugins you want into the new prefix.
5. Start the new version and confirm the configured provider/state behavior you expect.

Do not copy `node_modules` or `lib/node_modules` from an older bundle over a newer one.

EasyServer Local State and Secret Store data are normally outside the bundle under your user profile, so extracting a new version does not itself reset them. The [Package lifecycle](package-lifecycle.md) and [Versioning and compatibility](versioning-and-compatibility.md) documents define the supported state-preservation contract.

## What the portable artifact contains

Every platform artifact contains:

- the platform-native npm launcher (`easyserver.cmd` on Windows, `bin/easyserver` on Ubuntu/macOS);
- packed `@easyai101/easyserver` and `@easyai101/easyserver-plugin-sdk` packages;
- the CLI's production runtime dependencies, including the qualified platform keyring binary;
- a short bundle README and the MIT license.

It intentionally does not contain:

- Node.js;
- Vast.ai or Intelion.cloud Provider Plugins;
- repository source files, workspace symlinks, or development dependencies;
- maintainer/private release state.

Historical releases remain immutable: `v0.2.1` and earlier keep the assets originally published with those releases. Cross-platform portable GitHub Release artifacts begin with `v0.2.2`.
