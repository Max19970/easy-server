# @easycompute/plugin-sdk

Public contracts and TypeScript types for building EasyCompute Provider Plugins.

## Install

```sh
npm install @easycompute/plugin-sdk
```

Import only from the package root:

```ts
import type { ProviderPlugin } from "@easycompute/plugin-sdk";
```

Provider Plugins declare compatible EasyCompute and Plugin SDK SemVer ranges in their manifests. Source-file and `dist/` deep imports are not supported public APIs.

Plugin authoring guide: https://github.com/Max19970/easy-compute/blob/main/docs/plugin-authoring-and-operational-safety.md
