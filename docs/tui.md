# Interactive TUI

The EasyServer TUI is the preferred interface for ordinary interactive use. On a supported interactive terminal, run:

```powershell
easyserver
```

The TUI is a frontend over the same host-owned lifecycle, provider, credential, reconciliation, trust and connection operations used by command mode. It does not shell out to `easyserver` commands or parse human CLI output.

Use `easyserver --help` and the nested CLI help pages for scripting, automation, package-management tasks and advanced command-oriented workflows.

## Main destinations

The TUI starts from what the user wants to do rather than exposing EasyServer subsystems as peer tabs:

- **Home** — a short task launcher for renting compute, opening Servers, opening Connections, or entering Settings & Support;
- **Servers** — the user's compute inventory and lifecycle actions. **Rent a server** is an action/flow from Home or Servers, not a permanent global tab;
- **Connections** — local access to services running on the user's servers;
- **Settings & Support** — provider configuration, credentials and privacy-safe support tools such as Diagnostics.

Working pages use a breadcrumb-style path such as `Home › Servers › Rent server` and give the current task the full content area instead of keeping a permanent navigation sidebar beside it. `Esc` follows that hierarchy back toward Home.

Provider-specific forms remain Provider Plugin owned. Core renders the generic interaction contract; it does not hardcode provider-specific image, flavor, marketplace or pricing fields.

## Keyboard navigation

The ordinary TUI uses one navigation vocabulary instead of route-specific command alphabets:

- arrow keys — move through visible tasks, items, choices and actions;
- `Enter` — open the focused task, select/edit the focused item, or open/run its visible **Actions** menu;
- `Esc` — go back one breadcrumb level, cancel the current form/input, or decline a confirmation;
- `?` — open or close keyboard help;
- `Ctrl+C` — request TUI exit.

Primary actions are always visible in context after `Enter`; ordinary use does not require memorizing letter, number, bracket or case-sensitive shortcuts. Provider-owned forms use the same arrows/Enter/Esc model, and operation/confirmation drawers expose their available actions as a selectable list. Outcome-unknown operations remain observation/reconciliation problems rather than blind retry opportunities.

The TUI v2 transition deliberately uses progressive disclosure. Home hides control-plane health and provider internals behind the task hierarchy. Provider, server and connection screens keep technical IDs, provider metadata, exact remote targets, Access Method IDs, daemon state, Session IDs and saved Endpoint-intent state behind **Technical details** / **Advanced**; those details remain available rather than being removed.

## Servers and local connections

**Servers** is the ordinary lifecycle surface. Rows prioritize a human server name and current state; technical provider/canonical IDs stay in **Technical details**. Provider-declared lifecycle operations appear as visible actions such as **Start server** or **Stop server**. Large server lists are windowed to the available terminal rows while preserving selection by the canonical identity internally.

For ordinary access, select a fresh server and choose **Connect**. The guided flow asks for the application/service TCP port to expose on that server — for example `8188` for ComfyUI — not the SSH transport port, then asks for an optional local port. EasyServer keeps `127.0.0.1` as the ordinary remote-host default and deterministically selects the first supported provider-declared connection method without requiring the user to understand an Access Method ID or SSH routing. The review shows the server, app/service port, resulting local loopback address and lifetime before opening the connection. The local listener can exist before the first application client uses it, so the TUI calls that address ready but treats remote SSH/service reachability as verified on first use; a later failure remains recoverable in Connections rather than silently disappearing. Manual remote-host and exact connection-method selection remain available only in the Advanced flow.

**Connections** presents active access as local addresses such as `127.0.0.1:40123 → My server:8188`. Connections owned by the current TUI and background connections share this user-facing list; the latter are marked simply as **background**. Retryable connection setup failures keep the entered form values and expose visible **Retry connection** and **Open Diagnostics** actions instead of relying on hidden keyboard shortcuts; a deterministic local-port conflict instead prioritizes **Edit local port** and returns directly to that preserved field. If SSH succeeds but the requested app/service port is unavailable, the failure says that SSH itself works and prioritizes **Edit service port** while preserving the rest of the request. On constrained visual terminals every actionable foreground connection failure — including a failure that appears only after the local port was already published — owns the viewport so its explanation and recovery actions remain reachable. Late failed connections can retry the exact retained request in place; the old failed record is removed only after the replacement succeeds. Exact foreground/persistent ownership, daemon status, Session IDs, saved Endpoint definitions and Access Method details remain inspectable under **Technical details**. A failed background subsystem is shown as a secondary warning and does not hide healthy ordinary local connections.

First-use SSH trust is also recoverable inside the TUI. When a fingerprint is available, the trust screen shows the exact host, port, key type and SHA256 fingerprint and defaults focus to **Decline**. Saved background connection definitions that are waiting on `host-trust-required` expose **Review SSH fingerprint** in Technical details; accepting it enrolls only that reviewed key through EasyServer's caller-side trust path and retries the same saved definition. If the fingerprint changes while it is being reviewed, the TUI states that nothing was trusted and asks for a fresh review instead of telling the user to delete a non-existent stale entry. A genuinely changed already-trusted host remains a separate fail-closed error.

Connection diagnostics distinguish the major layers rather than collapsing them into “server unavailable”: SSH login rejection, changed host identity, inability to obtain a host fingerprint, SSH transport failure, an SSH server that forbids TCP forwarding, and a remote app/service port that refuses or cannot accept the forwarded connection. Raw OpenSSH stderr is not retained as normal TUI state; only privacy-safe normalized categories are shown. Diagnostics can check current EasyServer/provider/SSH-tool readiness, but the TUI does not claim that the support report contains raw details from a failed SSH attempt.

## Diagnostics and support reports

**Settings & Support → Diagnostics** opens with a short health/support summary instead of dumping the entire report into the working page. **View report** opens the exact sanitized report in a dedicated bounded viewer. In ordinary visual mode, long lines are wrapped to the current terminal width and ↑/↓ scroll through those physical rows while a fixed position indicator and **Enter Copy report · Esc Back** footer remain reachable. Copy always uses the same underlying sanitized payload that is being reviewed; scrolling or wrapping never changes the copied bytes.

Screen-reader mode renders the complete sanitized report linearly instead of clipping it to the visual viewport. Raw logs are deliberately not substituted for this report because they are outside the privacy-safe Diagnostics contract and may contain sensitive data.

## Narrow terminals and accessibility

EasyServer adapts the focused task page to the available terminal width and preserves the current page, canonical selections and focus state across resize. Long provider-backed lists, server inventories, local-connection lists and action menus keep the focused logical item inside the available terminal rows instead of rendering an unbounded list below the screen.

For a linear screen-reader-oriented terminal presentation, set:

```powershell
$env:INK_SCREEN_READER = 'true'
easyserver
Remove-Item Env:INK_SCREEN_READER
```

Screen-reader mode does not use the alternate screen. It exposes route, focus, content and command state as linear terminal text.

To suppress ANSI foreground colors while keeping the interactive TUI:

```powershell
$env:NO_COLOR = '1'
easyserver
Remove-Item Env:NO_COLOR
```

`INK_SCREEN_READER=true` and `NO_COLOR=1` can be used together.

## Interactive-terminal requirement

Plain `easyserver` intentionally means “open the TUI”. If stdin/stdout are not an interactive terminal, the no-argument invocation fails clearly with a non-zero exit status and does not emit alternate-screen/control output.

Use an explicit command in non-interactive contexts:

```powershell
easyserver --help
easyserver --version
easyserver instances list
```

This no-argument behavior is a compatibility-relevant change in the `0.2.0` line. `0.1.x` users or scripts that relied on a no-argument command-mode result must switch to the explicit command they intend, normally `easyserver --help` for help text.

## Provider setup and package-management boundary

The TUI can add and configure a Provider Plugin that is already installed in the EasyServer package environment. It deliberately does **not** install, update or uninstall npm packages. Packages that advertise EasyServer provider metadata appear by human display name under **Settings & Support → Providers → Add installed provider**; opening that picker reads package metadata only and does not execute an unconfigured plugin. Import/compatibility validation still happens only after the user explicitly chooses **Add**. Literal package names and local module paths remain available under **Advanced: add module or path**.

For a global npm installation, package ownership stays with npm:

```powershell
npm install --global @easyai101/easyserver-plugin-vastai
easyserver
```

Then open **Settings & Support → Providers**, choose **Add installed provider**, select **Vast.ai**, and configure its declared credential from the visible Actions menu. Provider and credential selection use the same ↑/↓ → Enter → Esc hierarchy as the rest of TUI v2; no Left/Right action toggle or provider-specific letter shortcut is required. Package installation itself remains outside the TUI; advanced command-mode equivalents remain available for automation.

For the portable GitHub Release ZIP, Provider Plugins must be installed into that extracted EasyServer prefix. Follow [Install from GitHub Releases](github-release-install.md#add-a-provider-plugin-later); installing a plugin into an unrelated global npm prefix does not make it part of the portable EasyServer environment.

A clean EasyServer installation contains zero Provider Plugins. The TUI keeps this state usable and routes setup through **Settings & Support → Providers** rather than treating the empty state as a fatal error.

## Credentials and confirmations

Credential values remain behind the EasyServer Secret Store boundary. The TUI shows declared credential names/readiness and uses masked input when setting a value; normal views, Diagnostics and operation errors must never echo the secret.

Billable/destructive risk comes from the Provider Plugin command contract but confirmation is host-owned. The TUI gives confirmation the foreground viewport, shows the target and consequence before dispatch, and initially focuses the safe Cancel/Decline choice so a stray first Enter cannot approve the mutation. SSH first-use trust likewise shows the exact discovered fingerprint and requires an explicit move to the trust action; changed trusted keys fail closed.

## Connection lifetime and exit

In ordinary TUI language, a **local connection** belongs to the current TUI and closes when this TUI exits; if any are still open, EasyServer requires a second quit confirmation and closes them before leaving. A **background connection** can remain available after TUI exit.

Internally these map to the existing foreground Endpoint and daemon-owned persistent Session / Endpoint-intent ownership models. That distinction, including desired-state recovery versus live runtime transport, remains visible under **Technical details** for troubleshooting and advanced management; hiding the ontology from the ordinary path does not merge or weaken the underlying lifetimes.

## Degraded and recovery states

Healthy TUI tasks remain usable when the host can represent a partial failure. The Servers surface shows results from available Providers first; a failed Provider is a secondary availability notice, not a prerequisite that blocks unrelated inventory. Examples include:

- one Provider is unavailable while another has fresh inventory;
- last-known instance observations are stale or a canonical instance is still unobserved;
- a Provider Plugin failed to load while another plugin remains healthy;
- the daemon is stopped, unreachable or has a cleanup-failed retained Session;
- a persisted Endpoint intent failed realization and can be retried safely;
- the primary Local State file is corrupt but a validated recovery generation can be loaded.

If both primary and recovery Local State are invalid, EasyServer fails closed instead of silently resetting or discarding configuration. Diagnostics expose a privacy-safe support payload rather than raw secrets/provider responses.

## Qualified release environment

The `0.2.0` TUI release surface is qualified on **Windows 11 x64** with **Node.js 24.18.1**. Release checks exercise the real terminal path at **60×20, 80×24 and 120×40**, plus resize, normal quit, Ctrl+C, `NO_COLOR`, screen-reader mode, thrown-error restoration, and two sequential EasyServer launches in the same terminal (including printable input on the second launch). Fidelity tests additionally keep focused/actionable content visible with **50 servers**, **50 provider-owned offer rows** and a **100+ line Diagnostics report** across the same release sizes. The release gate also launches the TUI from both the packed npm installation and the portable ZIP.

Linux and macOS are not qualified support targets yet. Do not infer a support promise from the fact that the code or Ink may run there; platform expansion is tracked separately and requires its own release-level qualification.
