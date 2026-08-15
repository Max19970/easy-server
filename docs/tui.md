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

The TUI v2 transition deliberately uses progressive disclosure. Home already hides control-plane health and provider internals behind the task hierarchy. Provider, server and connection detail screens continue moving technical IDs, provider metadata, remote targets and other deeper state behind **Details** / **Advanced** as their dedicated TUI v2 slices are completed; those details remain available rather than being removed.

## Narrow terminals and accessibility

EasyServer adapts the focused task page to the available terminal width and preserves the current page, canonical selections and focus state across resize. Long provider-backed lists and action menus keep the focused logical item inside the available terminal rows instead of rendering an unbounded list below the screen.

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

EasyServer has two different ownership models:

- **Foreground Endpoint** — owned by the current TUI process. It closes when this TUI exits. If foreground Endpoints are still live, the TUI requires a second quit confirmation and closes them before leaving.
- **Daemon-owned persistent Session / Endpoint intent** — owned by the EasyServer daemon and survives TUI exit. Closing the TUI does not silently stop these connections.

The Connections surface keeps desired persisted Endpoint intents separate from live runtime Sessions so disabled/error/recovery state is not confused with an active transport.

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

The `0.2.0` TUI release surface is qualified on **Windows 11 x64** with **Node.js 24.18.1**. Release checks exercise the real terminal path for normal quit, Ctrl+C, resize, compact layout, `NO_COLOR`, screen-reader mode, thrown-error restoration, and two sequential EasyServer launches in the same terminal (including printable input on the second launch), plus TUI launch from both the packed npm installation and the portable ZIP.

Linux and macOS are not qualified support targets yet. Do not infer a support promise from the fact that the code or Ink may run there; platform expansion is tracked separately and requires its own release-level qualification.
