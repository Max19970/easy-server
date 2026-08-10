# Versioning and compatibility

EasyServer packages use Semantic Versioning. While the project is in the `0.x` series, EasyServer deliberately provides a stronger compatibility promise than SemVer requires for patch releases.

## 0.x release lines

A `0.y` minor version is a compatibility line.

- `0.1.x` patch releases are backward-compatible maintenance releases. They may contain bug and security fixes, documentation corrections, dependency maintenance and other changes that do not require an existing user, script or compatible Provider Plugin to change.
- A breaking change to a supported public contract requires at least the next minor line, for example `0.2.0`. A `0.1.x` release must not knowingly break a `0.1.0` public contract.
- New functionality that materially expands or changes the public contract normally waits for the next `0.y.0` line. Small additive changes may ship in a patch only when they do not change the meaning or requirements of existing public behavior.
- A `0.y.0` release may make compatibility-breaking changes because EasyServer is still pre-1.0, but every such change must be called out explicitly in the release notes with migration guidance where applicable.

At `1.0.0`, EasyServer moves to the normal stable SemVer contract: breaking public changes require a major version, backward-compatible features use a minor version, and backward-compatible fixes use a patch version.

## Supported public contracts

For `0.1.x`, the compatibility promise covers only surfaces that are intentionally public and documented:

1. **Documented CLI behavior** — command names, documented options/arguments, exit-success/failure meaning and documented machine-consumable output where such output is explicitly promised. Human-oriented wording and formatting are not a byte-for-byte stable API unless documented otherwise.
2. **`@easyai101/easyserver-plugin-sdk` public exports** — the package root export and the Provider Plugin contracts/types reachable from it. A Provider Plugin should need no EasyServer source import or `dist/` deep import.
3. **Provider Plugin manifests and compatibility checks** — manifest fields, contribution contracts and the `compatibility.easyserver` / `compatibility.pluginSdk` SemVer ranges described in the plugin-authoring guide.
4. **Persisted Local State owned by EasyServer** — a later `0.1.x` release must continue to accept valid state created by an earlier `0.1.x` release. Patch releases must not require users to delete state or silently discard supported configuration. Raw credentials are never part of this compatibility contract because they must not be stored in Local State at all.
5. **First-party Provider Plugin behavior documented for the release** — normalized lifecycle/access behavior and the provider-specific public commands documented for Vast.ai and Intelion.cloud.
6. **Package identities and installation model** — `@easyai101/easyserver` remains the core CLI package, `@easyai101/easyserver-plugin-sdk` remains the public extension dependency, and first-party Provider Plugins remain separately installed opt-in packages.

## What is not a stable API

The following are internal or otherwise unstable unless a public document explicitly promotes them to a supported contract:

- source-file paths and implementation modules inside the monorepo;
- deep imports into a package's `dist/` directory;
- private classes, helpers, registries and host implementation details used only by EasyServer itself;
- test fixtures, internal test utilities and repository layout;
- exact human-facing diagnostic prose, log formatting and debug information;
- undocumented fields in provider-originated opaque diagnostic data;
- maintainer workflows, internal release evidence and private development documents.

The fact that JavaScript module resolution can technically reach an implementation file does not make that file a supported API.

`@easyai101/easyserver` is supported as a command-line product in `0.1.x`; it is not advertised as a general-purpose programmatic dependency. `@easyai101/easyserver-plugin-sdk` is the supported reusable package for third-party Provider Plugin development. Any additional programmatic API must be documented explicitly before it gains a compatibility promise.

## Provider Plugin compatibility

Every Provider Plugin manifest declares both host and SDK compatibility using SemVer ranges:

```ts
compatibility: {
  easyserver: "^0.1.0",
  pluginSdk: "^0.1.0",
}
```

For a `0.1.0` plugin, `^0.1.0` means the `0.1.x` compatibility line and excludes `0.2.0`. That matches the policy above: a plugin may rely on patch compatibility, while the next pre-1.0 minor line must be opted into deliberately after validation.

First-party Provider Plugins follow the same rule as third-party plugins. They are not exempt from host compatibility validation merely because they live in the same repository.

Package dependency ranges and manifest compatibility ranges serve different purposes: npm dependency ranges control module installation/resolution; manifest ranges are checked by EasyServer at runtime before a plugin is admitted. Both must agree with the supported compatibility line.

## Local State changes

Within `0.1.x`, state-format changes must be additive or transparently backward-compatible. A patch release must preserve existing valid state and secret references.

If a future `0.y.0` needs a breaking state change, the release must provide an explicit migration or a clearly documented safe transition. A release must never present deletion of user state as an invisible migration strategy.

## Deprecation and release notes

Before `1.0`, long deprecation windows are not guaranteed across different `0.y` lines, but avoidable breakage should still be announced before removal when practical.

Every release note must identify compatibility-relevant changes, including:

- CLI changes that can affect scripts or documented workflows;
- Plugin SDK or manifest changes;
- changes to Provider Plugin compatibility ranges;
- Local State migrations or compatibility implications;
- installation/package identity changes;
- platform/runtime support changes;
- security fixes that alter externally visible behavior.

A release with no compatibility-relevant changes should say so rather than leaving the question ambiguous.

## 0.1.0 package set

The first public release is one compatibility line built from:

- `@easyai101/easyserver-plugin-sdk@0.1.0`;
- `@easyai101/easyserver@0.1.0`;
- `@easyai101/easyserver-plugin-vastai@0.1.0`;
- `@easyai101/easyserver-plugin-intelion@0.1.0`.

The CLI depends on `@easyai101/easyserver-plugin-sdk` through `^0.1.0`. Both first-party plugins depend on the SDK through `^0.1.0`, and their runtime manifests require EasyServer and the Plugin SDK through `^0.1.0`. Those ranges intentionally accept the `0.1.x` line and reject `0.2.0`.
