# Security policy

**Languages:** English · [Русский](SECURITY.ru.md)

Please report suspected EasyServer vulnerabilities privately. Do **not** open a public GitHub issue for an undisclosed security problem.

The product's trust boundaries and security assumptions are documented separately in the [EasyServer security model](docs/security-model.md).

## Supported versions

While `0.2.x` is the current released compatibility line, security fixes target the latest released `0.2.x` version.

`0.1.x` no longer receives general maintenance. Critical security or data-integrity fixes may still be backported at maintainer discretion, but no indefinite backport promise is made.

Unreleased development snapshots are not a supported release line.

See [Support and maintenance](docs/support-and-maintenance.md) for the broader maintenance policy.

## Report a vulnerability

Use GitHub's private vulnerability reporting for this repository:

1. Open the repository's **Security** area.
2. Choose **Report a vulnerability**.
3. Describe the affected EasyServer/package version, environment, impact, and reproduction steps.
4. Include only the minimum sensitive evidence needed to reproduce the issue.

Do not include real API keys, private SSH keys, provider passwords, daemon bearer tokens, or unrelated provider/account data. Prefer redacted or synthetic values whenever possible.

## Disclosure and remediation

Reports are investigated and remediated on a best-effort basis. EasyServer does not promise a fixed acknowledgement/remediation SLA.

Coordinate disclosure through the private report while the issue is being assessed. Compatibility-relevant security changes affecting a released version are documented in the corresponding release notes.
