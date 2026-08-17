# Contributing to EasyServer

**Languages:** English · [Русский](CONTRIBUTING.ru.md)

Thanks for helping improve EasyServer. Contributions should preserve the product boundaries that let provider-specific behavior evolve without turning core into a collection of provider branches.

## Development setup

EasyServer `0.2.x` is developed and verified with Node.js `24.18.1` and npm `11.16.0`. The exact Node version is recorded in `.nvmrc`.

Install the repository dependencies:

```powershell
npm ci
```

Run the full deterministic release-level repository check before submitting a substantial change:

```powershell
npm run release:check
```

That check covers typechecking, tests, publishable package shapes, packaged installation, the current platform's portable release artifact, and real OS keyring integration. CI additionally exercises the Windows terminal-specific TUI surface and runs the same portable-artifact contract on every qualified release target.

`scripts/release-targets.mjs` is the authoritative portable-release target set. When platform qualification changes, update that contract together with the support/install documentation; CI and tag publication derive their build matrix from it, so a supported target cannot silently exist without a required artifact.

Ordinary development and pull-request validation must not require real provider credentials or paid resources. Live first-party provider acceptance is a maintainer release activity, not a normal contributor prerequisite.

## Propose a change

- Search existing issues before creating a duplicate.
- Open an issue first when the change needs product/architecture discussion or represents a non-trivial new capability.
- Keep a pull request focused on one coherent outcome.
- Add/update tests at public behavior seams when runtime behavior changes.
- Avoid tests coupled only to private helpers or implementation details that can change without changing the contract.
- Keep provider-specific acquisition/product semantics inside the owning Provider Plugin.
- Do not add provider-specific fields/branches to core when the Provider Feature/SDK seam already owns the variation.
- Keep public documentation current when behavior, compatibility, setup, security, or user workflows change.

Never commit API keys, passwords, private SSH keys, Secret Store contents, real-account acceptance state, or local machine-specific developer files.

## Provider Plugin contributions

Start with:

- [Build a Provider Plugin](docs/plugin-authoring.md)
- [Provider Plugin contracts and operational safety](docs/plugin-reference.md)
- [Minimal Provider Plugin example](examples/minimal-provider-plugin/README.md)

Plugins should depend on the public `@easyai101/easyserver-plugin-sdk` package, not EasyServer core source/deep imports.

Compatibility-sensitive changes must follow [Versioning and compatibility](docs/versioning-and-compatibility.md).

## Documentation contributions

Public documentation is organized by reader task and complexity:

`README → Getting Started → task guides → reference/policy → contributor/plugin docs → release history`

Keep introductory documents focused on the reader's immediate goal. Put dense contracts in reference surfaces rather than duplicating them across README/how-to pages.

Start at the [documentation index](docs/README.md). Translation structure and contribution rules are documented in [Documentation localization](docs/localization.md).

## Security issues

Do not report suspected vulnerabilities in a public issue or pull request. Follow [SECURITY.md](SECURITY.md) instead.
