# Security policy

EasyServer's trust boundaries and security assumptions are documented in [`docs/security-model.md`](docs/security-model.md).

## Supported versions

While `0.1.x` is the current released minor line, security fixes target the latest released `0.1.x` version. After a newer minor becomes current, critical security or data-integrity fixes may be backported to `0.1.x` at maintainer discretion, but general maintenance and indefinite backport support are not promised. Unreleased development snapshots are not a supported release line.

See [Support and maintenance policy](docs/support-and-maintenance.md) for the broader maintenance rules.

## Reporting a vulnerability

Please do **not** open a public GitHub issue for a suspected or undisclosed vulnerability.

Use GitHub's private vulnerability reporting for this repository:

1. Open the repository's **Security** area.
2. Choose **Report a vulnerability**.
3. Describe the affected EasyServer/package version, environment, impact and reproduction steps.
4. Include only the minimum sensitive evidence required to reproduce the issue.

Private vulnerability reporting is enabled for EasyServer. Do not include real API keys, private SSH keys, daemon bearer tokens, raw credentials or unrelated provider/account data; use redacted or synthetic values whenever possible.

Confirmed security issues are investigated and remediated on a best-effort basis. EasyServer does not promise a fixed acknowledgement or remediation SLA. We will coordinate remediation and disclosure through the private report, and compatibility-relevant fixes affecting a released version will be called out in the corresponding release notes.
