# @easycompute/plugin-sdk

Public contracts and TypeScript types for building EasyCompute Provider Plugins. This is the supported reusable programmatic EasyCompute dependency in `0.1.x`; `@easycompute/cli` is intentionally CLI-only.

## Install

```sh
npm install @easycompute/plugin-sdk
```

Import only from the package root:

```ts
import type { ProviderPlugin } from "@easycompute/plugin-sdk";
```

For TypeScript 6 Node projects, include Node's ambient types in the consumer `tsconfig.json` (for example `"types": ["node"]`). The SDK installs the matching Node 24 declarations because its public Access Channel contract uses the exact `node:stream.Duplex` type.

Provider Plugins declare compatible EasyCompute and Plugin SDK SemVer ranges in their manifests. Source-file and `dist/` deep imports are not supported public APIs.

Plugin authoring guide: https://github.com/Max19970/easy-compute/blob/main/docs/plugin-authoring-and-operational-safety.md
