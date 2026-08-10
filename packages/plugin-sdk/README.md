# @easyai101/easyserver-plugin-sdk

Public contracts and TypeScript types for building EasyServer Provider Plugins. This is the supported reusable programmatic EasyServer dependency in `0.1.x`; `@easyai101/easyserver` is intentionally CLI-only.

## Install

```sh
npm install @easyai101/easyserver-plugin-sdk
```

Import only from the package root:

```ts
import type { ProviderPlugin } from "@easyai101/easyserver-plugin-sdk";
```

For TypeScript 6 Node projects, include Node's ambient types in the consumer `tsconfig.json` (for example `"types": ["node"]`). The SDK installs the matching Node 24 declarations because its public Access Channel contract uses the exact `node:stream.Duplex` type.

Provider Plugins declare compatible EasyServer and Plugin SDK SemVer ranges in their manifests. Source-file and `dist/` deep imports are not supported public APIs.

Plugin authoring guide: https://github.com/Max19970/easy-server/blob/main/docs/plugin-authoring-and-operational-safety.md
