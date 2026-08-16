# Minimal Provider Plugin example

This directory is a deliberately small third-party-style EasyServer Provider Plugin built only against the public `@easyai101/easyserver-plugin-sdk` package.

It is intentionally outside the repository's npm workspace graph so it remains representative of an external provider package rather than silently depending on EasyServer source internals.

## What the example demonstrates

Read `index.mjs` from top to bottom. It shows:

- manifest identity and EasyServer/Plugin SDK compatibility ranges;
- a normalized Provider Adapter with inventory and authoritative `getInstance()` behavior;
- a declared `api-key` credential name;
- resolving that credential through `context.resolveCredential()` instead of storing raw secret values;
- a secret-free SSH Access Method that reuses EasyServer's built-in SSH transport;
- one provider-owned read-only `catalog/show` Provider Feature;
- no lifecycle capability or custom Access Adapter when the example does not need one.

The feature is intentionally read-only. A fake mutation would teach the wrong lessons about dispatch, idempotency, and `outcome-unknown`; those contracts are documented separately.

## Use it as a scaffold

The example package is marked `private` only to prevent this repository from accidentally publishing the example name.

When adapting it for a real provider:

1. choose your own package name and stable provider/plugin IDs;
2. remove `private` when the package is meant to be published;
3. add only the capabilities/features/transports your provider actually supports;
4. keep provider-specific acquisition/configuration inside Provider Features;
5. validate the packed package from an external install layout before publishing.

## Read the full contracts

- [Build a Provider Plugin](../../docs/plugin-authoring.md)
- [Provider Plugin contracts and operational safety](../../docs/plugin-reference.md)
- [`@easyai101/easyserver-plugin-sdk`](../../packages/plugin-sdk/README.md)
