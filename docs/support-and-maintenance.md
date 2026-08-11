# Support and maintenance policy

EasyServer is a young open-source project. The `0.1.x` line is maintained on a best-effort basis, with compatibility rules defined by [Versioning and compatibility](versioning-and-compatibility.md). This policy explains what users and contributors can expect without creating an enterprise-style SLA or an indefinite support promise.

## Reporting bugs and provider regressions

Use a public GitHub issue for ordinary product bugs and regressions. Include, where relevant:

- EasyServer and Provider Plugin versions;
- operating system and Node.js version;
- the command or public workflow that failed;
- expected and observed behavior;
- a minimal reproduction or sanitized diagnostic output.

Provider-specific breakage should name the affected provider and whether the same workflow worked previously. Prefer attaching the output of `easyserver doctor` instead of raw logs when it contains enough information to reproduce or triage the problem.

Never include API keys, passwords, private SSH material, bearer tokens, daemon authentication tokens, raw credential values, Secret References such as `secret:<uuid>`, provider resource/account identifiers, or raw provider payloads that may contain sensitive account data. Do not paste a whole `~/.easyserver` directory, OS-keyring export or unreviewed debug log into a public issue.

### Privacy-safe diagnostics

`easyserver doctor` produces a JSON troubleshooting payload designed to be safe to review and paste into a public bug report. It reports only bounded product/runtime state:

- EasyServer, Node.js, operating-system platform and architecture versions;
- whether Local State is readable plus counts of configured plugins, credential bindings and canonical instance bindings;
- configured Provider Plugin status, safe plugin/provider identity where available, and loaded plugin version;
- coarse plugin failure classes such as `incompatible`, `timeout` or `load-failed` instead of raw exception text;
- daemon health and, when available, only the count of daemon-owned sessions;
- local OpenSSH command availability needed for SSH access troubleshooting.

The diagnostic payload intentionally excludes credential values and Secret References, SSH private keys, daemon tokens and loopback descriptor details, canonical/provider instance identifiers, provider-originated names/payloads, local plugin filesystem paths and raw plugin/provider exception text. EasyServer does not dispatch provider operations or resolve configured credentials in order to build this report.

Review the generated JSON before posting it anyway, especially when using third-party Provider Plugins. A plugin module is ordinary JavaScript and may have its own import-time behavior outside EasyServer's diagnostic payload contract.

Security vulnerabilities are different: report them privately using the repository's **Security → Report a vulnerability** flow, as described in the root [`SECURITY.md`](../SECURITY.md). Do not open a public issue for an undisclosed vulnerability.

## Triage and patch releases

While `0.1.x` is the current released minor line, confirmed regressions in documented public behavior are candidates for the next `0.1.x` patch when they can be fixed without breaking the `0.1.x` compatibility contract.

A patch release may contain:

- backward-compatible bug and security fixes;
- Provider Plugin compatibility repairs for upstream provider changes;
- dependency maintenance;
- documentation corrections;
- small additive changes that do not change existing public requirements.

A change that requires existing users, scripts or compatible Provider Plugins to change belongs in a later minor line such as `0.2.0`, unless an external service has made the old behavior impossible or unsafe. Such exceptional cases must be documented explicitly rather than disguised as ordinary patch compatibility.

After a newer minor line such as `0.2.x` becomes the current release line, `0.1.x` no longer receives general maintenance. Critical security or data-integrity fixes may still be backported at maintainer discretion, but no backport commitment or fixed end-of-life date is promised.

## First-party Provider Plugins

The first-party Vast.ai and Intelion.cloud Provider Plugins are maintained under the same `0.1.x` compatibility line as the core packages while their documented provider integrations remain viable.

Provider APIs and policies are external dependencies. If an upstream provider change temporarily breaks an integration, maintainers will prefer one of these outcomes:

1. ship a backward-compatible Provider Plugin repair in the next patch;
2. document a temporary known limitation when the provider-side condition cannot be repaired immediately;
3. deprecate or remove support in a later minor release when continued compatibility is no longer practical.

A `0.1.x` patch should not silently remove a still-viable documented provider contract. If a provider shuts down, withdraws the required API or otherwise makes the existing contract impossible, EasyServer may fail that provider clearly and update the documentation even though the external service is no longer usable.

## Security handling

Private vulnerability reports are acknowledged and investigated on a best-effort basis. Confirmed vulnerabilities are prioritized according to severity and user impact. A compatible fix may be released as an urgent `0.1.x` patch when that line is current; compatibility-breaking remediation moves to a later minor unless preserving the old behavior would keep users unsafe.

EasyServer does not promise a fixed acknowledgement time, remediation time or release deadline. Reporters should avoid public disclosure until maintainers have had a reasonable opportunity to assess and ship a fix.

## What this policy does not promise

There is no paid support contract, uptime guarantee, provider availability guarantee, response-time SLA, guaranteed release cadence or perpetual maintenance commitment for pre-1.0 lines. Maintainers may prioritize work based on severity, reproducibility, user impact and available project capacity.

The compatibility promises in the versioning policy remain the source of truth for what a release may change; this document only defines how maintenance work is triaged and supported over time.
