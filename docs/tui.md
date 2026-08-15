# Interactive TUI

The EasyServer TUI is the preferred interface for ordinary interactive use. On a supported interactive terminal, run:

```powershell
easyserver
```

The TUI is a frontend over the same host-owned lifecycle, provider, credential, reconciliation, trust and connection operations used by command mode. It does not shell out to `easyserver` commands or parse human CLI output.

Use `easyserver --help` and the nested CLI help pages for scripting, automation, package-management tasks and advanced command-oriented workflows.

## Main destinations

The primary destinations are:

- **Overview** — readiness, instance inventory, daemon/connection state and support entry points;
- **Instances** — normalized inventory, adoption and single/bulk lifecycle operations;
- **Providers** — register an already installed Provider Plugin, inspect readiness, enable/disable it and configure declared credentials;
- **New instance** — provider-owned interactive acquisition flows such as Vast.ai marketplace rental or Intelion.cloud server configuration;
- **Connections** — foreground Endpoints, daemon-owned persistent Sessions and persisted Endpoint intents;
- **Diagnostics** — privacy-safe troubleshooting data that can be reviewed before copying or sharing.

Provider-specific forms remain Provider Plugin owned. Core renders the generic interaction contract; it does not hardcode provider-specific image, flavor, marketplace or pricing fields.

## Keyboard navigation

The ordinary TUI uses one navigation vocabulary instead of route-specific command alphabets:

- arrow keys — move through sections, items, choices and visible actions;
- `Enter` — open the focused section, select/edit the focused item, or open/run its visible **Actions** menu;
- `Esc` — go back one level, cancel the current form/input, or decline a confirmation;
- `Tab` / `Shift+Tab` — return to and move through the main section navigation;
- `?` — open or close keyboard help;
- `Ctrl+C` — request TUI exit.

Primary actions are always visible in context after `Enter`; ordinary use does not require memorizing letter, number, bracket or case-sensitive shortcuts. Provider-owned forms use the same arrows/Enter/Esc model, and operation/confirmation drawers expose their available actions as a selectable list. Outcome-unknown operations remain observation/reconciliation problems rather than blind retry opportunities.

The main surfaces deliberately use progressive disclosure. Instance, Provider and Connection lists show the information needed to identify the current object first; technical IDs, provider metadata, remote targets and other deeper detail are available through **Show details** rather than occupying the default view.

## Narrow terminals and accessibility

EasyServer has both wide and compact layouts. The compact layout is selected below 72 terminal columns and preserves the active destination, canonical selections and focus state across resize. Long provider-backed lists and action menus keep the focused logical item inside the available terminal rows instead of rendering an unbounded list below the screen.

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

The TUI can register and configure a Provider Plugin that is already installed in the EasyServer package environment. It deliberately does **not** install, update or uninstall npm packages.

For a global npm installation, package ownership stays with npm:

```powershell
npm install --global @easyai101/easyserver-plugin-vastai
easyserver
```

Then open **Providers** and register/configure the installed package, or use the equivalent explicit CLI commands.

For the portable GitHub Release ZIP, Provider Plugins must be installed into that extracted EasyServer prefix. Follow [Install from GitHub Releases](github-release-install.md#add-a-provider-plugin-later); installing a plugin into an unrelated global npm prefix does not make it part of the portable EasyServer environment.

A clean EasyServer installation contains zero Provider Plugins. The TUI keeps this state usable and points to **Providers** as the next setup step rather than treating it as an error.

## Credentials and confirmations

Credential values remain behind the EasyServer Secret Store boundary. The TUI shows declared credential names/readiness and uses masked input when setting a value; normal views, Diagnostics and operation errors must never echo the secret.

Billable/destructive risk comes from the Provider Plugin command contract but confirmation is host-owned. The TUI gives confirmation the foreground viewport, shows the target and consequence before dispatch, and initially focuses the safe Cancel/Decline choice so a stray first Enter cannot approve the mutation. SSH first-use trust likewise shows the exact discovered fingerprint and requires an explicit move to the trust action; changed trusted keys fail closed.

## Connection lifetime and exit

EasyServer has two different ownership models:

- **Foreground Endpoint** — owned by the current TUI process. It closes when this TUI exits. If foreground Endpoints are still live, the TUI requires a second quit confirmation and closes them before leaving.
- **Daemon-owned persistent Session / Endpoint intent** — owned by the EasyServer daemon and survives TUI exit. Closing the TUI does not silently stop these connections.

The Connections surface keeps desired persisted Endpoint intents separate from live runtime Sessions so disabled/error/recovery state is not confused with an active transport.

## Degraded and recovery states

Healthy TUI sections remain usable when the host can represent a partial failure. The Instances surface shows results from available Providers first; a failed Provider is a secondary availability notice, not a prerequisite that blocks unrelated inventory. Examples include:

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
