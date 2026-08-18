# Versioning and compatibility

EasyServer packages use Semantic Versioning. Because the project is still pre-1.0, a minor version defines a compatibility line and patch releases inside that line carry a stronger stability promise than bare SemVer would require.

## Pre-1.0 compatibility lines

For a line such as `0.2.x`:

- patch releases are backward-compatible maintenance releases;
- a patch must not knowingly require existing users, scripts, valid Local State, or compatible Provider Plugins on that line to change;
- breaking changes to supported public contracts require at least the next minor line (`0.3.0` after `0.2.x`);
- material new contracts normally wait for the next minor line, while small additive changes can ship in a patch when existing behavior keeps the same meaning;
- a new `0.y.0` may make breaking changes, but release notes must call them out and provide migration guidance when users need to act.

At `1.0.0`, EasyServer will follow the normal stable SemVer model: breaking changes require a major release, backward-compatible features a minor release, and backward-compatible fixes a patch release.

## Supported public contracts

Compatibility applies only to surfaces the project intentionally documents as public.

### CLI behavior

Documented command names, options/arguments, success/failure semantics, and explicitly documented machine-readable output are public contracts.

Human-oriented prose, spacing, and presentation are not byte-for-byte APIs unless a document explicitly says otherwise.

The versioned `--json` contract is documented in [Machine-readable CLI output](cli-json.md).

### Provider Plugin SDK

Public exports from the package root of `@easyai101/easyserver-plugin-sdk` are the supported programmatic extension API.

Source-file paths, EasyServer core internals, and `dist/` deep imports are not supported plugin APIs.

See [Build a Provider Plugin](plugin-authoring.md) and [Provider Plugin contracts and operational safety](plugin-reference.md).

### Provider Plugin manifests and contributions

Documented manifest fields, compatibility ranges, Provider/Feature/Access Adapter contracts, and the side-effect-free provider-help contribution are part of the plugin contract.

First-party plugins follow the same compatibility rules as third-party plugins.

### EasyServer Local State

A later patch in the same compatibility line must continue to accept valid state created earlier in that line.

Patch-level state changes must therefore be additive or transparently backward-compatible. A breaking state transition in a future minor line requires an explicit migration/safe transition; silently deleting user state is not a migration strategy.

EasyServer `0.2.0` also accepts valid `0.1.x` Local State.

See [Package lifecycle](package-lifecycle.md) for upgrade/reinstall/uninstall behavior.

### First-party provider behavior

Provider-specific public commands and provider integration behavior documented for the compatibility line are covered by the same patch-stability expectation, subject to upstream provider APIs/policies remaining viable.

Provider-owned raw API shapes or undocumented raw transcript contents are not promoted to core EasyServer compatibility merely because they can be observed.

### Package identities and installation model

The documented package roles are part of the public distribution model:

- `@easyai101/easyserver` — CLI/TUI product;
- `@easyai101/easyserver-plugin-sdk` — reusable public Provider Plugin API;
- first-party Provider Plugins — separately installed opt-in packages.

`@easyai101/easyserver` is not advertised as a general-purpose programmatic library. The Plugin SDK is the supported reusable dependency for provider extensions.

First-party Provider Plugins are independently versioned products with their own repositories and release histories. Their package SemVer and their EasyServer/Plugin SDK compatibility ranges are separate axes: a plugin feature release does not require a matching EasyServer version bump, and an EasyServer release does not require republishing an unchanged plugin for numerical symmetry.

## Provider Plugin compatibility ranges

A plugin compatible with the EasyServer/Plugin SDK `0.2.x` line normally declares:

```ts
compatibility: {
  easyserver: "^0.2.0",
  pluginSdk: "^0.2.0",
}
```

For pre-1.0 SemVer, `^0.2.0` accepts compatible `0.2.x` releases and excludes `0.3.0`.

Package dependency ranges and runtime manifest ranges are separate checks:

- npm dependency ranges control package resolution/installation;
- manifest compatibility ranges are validated by EasyServer before a plugin is admitted.

A published plugin should widen either range only after being validated against the newly accepted line.

## What is not stable by default

Unless another public document explicitly promotes it, do not rely on:

- monorepo source-file paths or repository layout;
- private classes/helpers/registries;
- package `dist/` deep imports;
- test fixtures/internal test utilities;
- exact human-facing diagnostic wording or debug log formatting;
- undocumented provider-originated payload fields;
- maintainer release procedures or private development state.

Technical reachability is not the same as public API status.

## Deprecation and release notes

Before 1.0, different minor lines do not promise long deprecation windows, but avoidable breakage should still be announced before removal when practical.

Release notes must identify compatibility-relevant changes such as:

- CLI changes that affect documented scripts/workflows;
- Plugin SDK/manifest changes;
- Provider Plugin compatibility-range changes;
- Local State migrations/compatibility implications;
- package/distribution changes;
- platform/runtime support changes;
- security fixes that materially change public behavior.

If a release has no compatibility-relevant change, its release notes should say so rather than leaving the status ambiguous.

For shipped package/version snapshots and migration notes, use the documents under [Release history](README.md#release-history) rather than treating this policy page as a changelog.
