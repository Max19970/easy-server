# Support and maintenance

EasyServer is a young open-source project maintained on a best-effort basis. This page explains where to report problems and what maintenance users should expect without implying an enterprise support contract or fixed release cadence.

Compatibility guarantees are defined separately in [Versioning and compatibility](versioning-and-compatibility.md). Security vulnerabilities use the private process in [SECURITY.md](../SECURITY.md).

## Report an ordinary bug

Open a public GitHub issue for reproducible product bugs, usability defects, provider regressions, and documentation problems.

Useful reports include:

- EasyServer version;
- Provider Plugin/version when the problem is provider-specific;
- operating system and Node.js version;
- the command or TUI workflow that failed;
- what you expected and what happened instead;
- a minimal reproduction when practical;
- a reviewed/sanitized Diagnostics report when it helps.

For provider regressions, name the affected provider and say whether the same workflow previously worked.

Do not include secrets or private account material in a public issue.

## Use privacy-safe Diagnostics

The TUI exposes **Settings & Support → Diagnostics**. Command mode also provides:

```powershell
easyserver doctor
```

The report is designed to provide bounded product/runtime health information without resolving provider credentials or dumping raw provider responses.

It can include information such as:

- EasyServer, Node.js, platform, and architecture versions;
- whether Local State is readable and coarse counts of configured objects;
- configured Provider Plugin load/readiness state and loaded versions;
- coarse plugin failure classes;
- daemon health and bounded connection counts;
- local OpenSSH tool availability.

It intentionally excludes raw credential values and Secret References, private SSH material, daemon bearer tokens, loopback descriptor secrets, provider account/resource identifiers, local plugin filesystem paths, and raw provider/plugin exception bodies from the normal support payload.

Review the generated report before posting it anyway, especially when third-party Provider Plugins are installed.

## Never paste these into a public issue

Do not publish:

- API keys/tokens;
- passwords;
- private SSH keys;
- bearer/session/daemon authentication tokens;
- raw credential values;
- Secret References such as `secret:<uuid>`;
- unreviewed `~/.easyserver` contents;
- OS-keyring exports;
- raw provider payloads containing account/resource data;
- unreviewed debug logs.

If the issue is a suspected vulnerability rather than an ordinary bug, stop and use the private vulnerability-reporting path in [SECURITY.md](../SECURITY.md).

## Maintenance of the current line

While `0.2.x` is the current released compatibility line, confirmed regressions in documented `0.2.x` behavior are candidates for a patch release when they can be fixed without breaking that line's public contract.

A compatible patch may include:

- bug/security fixes;
- repairs for upstream provider API changes;
- dependency maintenance;
- documentation corrections;
- small additive changes that do not change existing requirements.

A change that requires users, scripts, or compatible Provider Plugins to migrate normally belongs in the next minor compatibility line.

`0.1.x` no longer receives general maintenance while `0.2.x` is current. Critical security/data-integrity fixes may be backported at maintainer discretion, but there is no indefinite backport promise.

## First-party provider maintenance

The Vast.ai and Intelion.cloud plugins are maintained in their own repositories and release independently from EasyServer. Their manifests declare which EasyServer/Plugin SDK compatibility lines they accept; package version numbers do not need to match the host numerically.

Provider APIs/policies are external dependencies. When an upstream change breaks an integration, the project may:

1. ship a backward-compatible plugin repair;
2. document a temporary limitation while a repair is unavailable;
3. deprecate/remove the integration in a later compatibility line when the upstream contract is no longer practical.

If the provider itself removes an API or service needed by the integration, EasyServer cannot guarantee continued provider availability; it should fail the affected provider clearly rather than corrupt unrelated provider state.

## Security handling

Private vulnerability reports are investigated and remediated on a best-effort basis. A compatible fix can ship as a patch in the current line; compatibility-breaking remediation moves to a later line unless preserving old behavior would keep users unsafe.

No fixed acknowledgement/remediation SLA is promised. Coordinate disclosure through the private report rather than opening a public issue for an undisclosed vulnerability.

## What support does not promise

EasyServer currently provides no:

- paid support contract;
- response-time SLA;
- uptime/provider-availability guarantee;
- guaranteed release cadence;
- perpetual maintenance commitment for pre-1.0 lines.

Maintainers may prioritize based on severity, reproducibility, user impact, security/data-integrity risk, and available project capacity.
