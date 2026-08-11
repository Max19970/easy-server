# Minimal Provider Plugin example

This directory is a deliberately small third-party-style EasyServer Provider Plugin. It depends only on the public `@easyai101/easyserver-plugin-sdk` package and is intentionally outside the repository's npm workspace graph.

Read `index.mjs` from top to bottom: it demonstrates the recommended minimum extension surfaces without production-provider HTTP/client noise:

- manifest identity plus EasyServer/Plugin SDK compatibility ranges;
- a normalized Provider Adapter with inventory and authoritative `getInstance()` behavior;
- declaring `api-key` as a required credential in manifest metadata so the host can validate names and expose readiness without reading the secret;
- resolving that plugin-owned named credential through `context.resolveCredential()` instead of storing raw secrets;
- a secret-free SSH Access Method while leaving generic SSH transport to EasyServer's built-in Access Adapter;
- a provider-owned `catalog/show` CLI command contributed through a Provider Feature;
- no lifecycle capabilities or custom Access Adapter when the example does not actually need them.

A real acquisition flow is also provider-specific and belongs in a Provider Feature, but this reference intentionally keeps its feature read-only so it does not teach fake mutation/idempotency semantics. The full guide covers mutation dispatch, `outcome-unknown`, provider-deferred access credentials and custom Access Adapters for providers that genuinely need them.

The package is marked `private` only so this repository cannot accidentally publish the example name. When using it as a scaffold, choose your own package name and remove `private` before publishing.

The release verification packs this directory, installs it outside the monorepo alongside packed EasyServer artifacts, registers it with `easyserver plugins add @easyai101/easyserver-example-provider`, verifies that the host loads provider `example`, and invokes its provider-owned `catalog/show` command through the installed CLI.

See [`../../docs/plugin-authoring-and-operational-safety.md`](../../docs/plugin-authoring-and-operational-safety.md) for the complete contract, including mutation/acquisition and custom-transport patterns.
