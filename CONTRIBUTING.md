# Contributing to EasyServer

Thanks for helping improve EasyServer.

## Development setup

EasyServer 0.1.x is developed and verified with Node.js 24.18.1 and npm 11.16.0. The exact Node version is recorded in `.nvmrc`.

```sh
npm ci
npm run release:check
```

`release:check` typechecks, builds, runs the deterministic test suites, dry-runs every publishable workspace package, verifies clean packaged installs and builds/checks the supported GitHub Release artifact from a clean extracted copy.

Ordinary development and pull-request validation must not require real provider credentials or paid compute resources. Live Vast.ai/Intelion.cloud acceptance is a maintainer release activity, not a normal contributor prerequisite.

## Proposing changes

- Open an issue first when the change needs product or architectural discussion, or when you have found a reproducible defect that is not already tracked.
- Keep pull requests focused on one coherent change.
- Add or update tests at public behavior seams when behavior changes. Avoid tests coupled only to private helpers or removed implementation details.
- Keep Provider-specific acquisition and behavior inside the owning Provider Plugin rather than adding Provider branches to core.
- Never commit API keys, passwords, private SSH keys, secret-store contents, real-account acceptance state or local machine-specific developer files.
- Run `npm run release:check` before submitting a pull request.

For product scope and architecture boundaries, start with the [README](README.md). Provider Plugin authors should also read [`docs/plugin-authoring-and-operational-safety.md`](docs/plugin-authoring-and-operational-safety.md). Compatibility-sensitive changes must follow [`docs/versioning-and-compatibility.md`](docs/versioning-and-compatibility.md).

## Security issues

Do not report suspected vulnerabilities in a public issue. Follow [`SECURITY.md`](SECURITY.md) instead.
