# EasyCompute 0.1.0 dependency and supply-chain audit

Audit date: 2026-08-10.

This report records the production dependency surface reviewed for the first public `0.1.0` release. It is a release snapshot, not a promise that registry advisories can never change after publication.

## Production dependency surface

`@easycompute/plugin-sdk` has no external executable runtime dependency. It installs `@types/node@24.13.3` (and its `undici-types` declaration dependency) because the public Access Channel contract intentionally exposes the exact Node `Duplex` type. These packages are declaration-only and are not executed by EasyCompute at runtime.

`@easycompute/plugin-vastai` and `@easycompute/plugin-intelion` each depend only on `@easycompute/plugin-sdk`. They are separately installed Provider Plugins and are not dependencies of `@easycompute/cli`.

`@easycompute/cli` has exactly three direct runtime dependencies:

| Dependency | 0.1.0 range/version | Runtime reason | License |
| --- | --- | --- | --- |
| `@easycompute/plugin-sdk` | `^0.1.0` | Public/runtime Provider Plugin contracts, validation, normalized errors and operation types | MIT |
| `@napi-rs/keyring` | `1.3.0` | OS-backed Secret Store used to keep credentials out of Local State | MIT |
| `semver` | `7.7.2` | Runtime validation of Provider Plugin EasyCompute/Plugin SDK compatibility ranges | ISC |

The SDK's installed Node declaration packages (`@types/node@24.13.3` and `undici-types@7.18.0`) are also MIT-licensed. The ISC and MIT dependency licenses are permissive and compatible with distributing EasyCompute itself under MIT. No copyleft or source-availability dependency license appears in the production closure reviewed for `0.1.0`.

## Native dependency

`@napi-rs/keyring@1.3.0` is the only native runtime dependency. The JavaScript wrapper selects a platform-specific optional package containing a prebuilt native `.node` binary.

For the supported Windows 11 x64 release path, npm installs `@napi-rs/keyring-win32-x64-msvc@1.3.0`. The reviewed installed package contains its package metadata/README plus one prebuilt native module (`keyring.win32-x64-msvc.node`, approximately 1.8 MB).

The keyring wrapper and every platform-specific optional package recorded in `package-lock.json` are MIT-licensed. None of those lockfile entries has an npm install script. In particular, the supported Windows package does not compile native code or execute a download/build script during EasyCompute installation; npm selects the prebuilt package by OS/CPU metadata.

EasyCompute separately verifies a real create/read/delete round trip through the OS keyring on the supported Windows platform. Platform support is therefore not inferred merely from the existence of native packages; see [Supported platforms](supported-platforms.md).

## Install-time scripts

The reviewed `package-lock.json` contains no dependency entry marked with `hasInstallScript`. EasyCompute's own publishable packages use build/prepack lifecycle scripts while creating their release artifacts, but the published runtime tarballs contain already-built `dist/` output and do not rely on a consumer-side postinstall installer.

The repository root is intentionally non-publishable and has a failing `prepublishOnly` guard in addition to `private: true`. This prevents accidentally publishing the monorepo root even though npm can still assemble a dry-run payload for a private package.

## Registry integrity and advisories

Using the release npm version (`11.16.0`) against the locked tree on 2026-08-10:

```text
npm audit --omit=dev --audit-level=low
→ found 0 vulnerabilities

npm audit signatures --omit=dev
→ 5 packages have verified registry signatures
→ 4 packages have verified attestations
```

Registry tarballs for the reviewed external runtime dependencies are pinned by `package-lock.json` integrity hashes. `npm ci` is used for deterministic repository/CI installation rather than updating the lockfile implicitly.

No known high/critical (or lower-severity) npm advisory affecting the audited production tree remained at this checkpoint.

## Publishable EasyCompute tarballs

The release gate performs executable `npm pack` verification for every publishable EasyCompute package. It rejects unexpected paths and requires each package artifact to contain only:

```text
LICENSE
README.md
package.json
dist/**
```

The external minimal Provider Plugin example has its own exact scaffold allowlist.

The same packaged-install test creates isolated global npm prefixes outside the monorepo, installs the packed CLI/SDK, runs the actual npm-created `easycompute` executable, and validates explicit Provider Plugin registration. It also creates a separate TypeScript consumer project in a temporary directory, installs only the packed SDK as its EasyCompute dependency, compiles a provider plus Node `Duplex`-backed Access Adapter through package-root declarations, and runs the emitted module.

## Minimal-install boundary

A packed `@easycompute/cli` installation has no Vast.ai or Intelion.cloud package present and reports no configured Provider Plugins. The verification then independently installs one Provider Plugin at a time and proves the unrelated Provider Plugin remains absent.

This is an executable release contract, not only a manifest review. It protects the intended model that Provider Plugins are optional user choices rather than transitive CLI dependencies.

## Release audit commands

The release snapshot was checked with:

```sh
npm ls --omit=dev --all
npm audit --omit=dev --audit-level=low
npm audit signatures --omit=dev
npm run verify:packaged-install
npm run verify:os-keyring
npm run release:check
```

The advisory/signature commands are registry-dependent release checks and are intentionally not folded into the deterministic test gate. They should be rerun immediately before publication.

## Result

The `0.1.0` production dependency surface is small and justified, the supported native dependency path is understood, no dependency install scripts are required, dependency licenses are compatible with MIT distribution, the audited registry tree had no known vulnerabilities, and packaged-install verification preserves the zero-bundled-Provider contract.
