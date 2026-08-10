# Minimal Provider Plugin example

This directory is a deliberately small third-party-style EasyCompute Provider Plugin. It depends only on the public `@easycompute/plugin-sdk` package and exposes one provider with no lifecycle capabilities.

The package is marked `private` only so this repository cannot accidentally publish the example name. When using it as a scaffold, choose your own package name and remove `private` before publishing.

The release verification packs this directory, installs it outside the monorepo alongside packed EasyCompute artifacts, registers it with `easycompute plugins add @easycompute/example-provider`, and verifies that the host loads provider `example`.

See [`../../docs/plugin-authoring-and-operational-safety.md`](../../docs/plugin-authoring-and-operational-safety.md) for the complete contract.
