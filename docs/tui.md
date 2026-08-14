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

The footer and `?` help surface show the currently available controls. The common navigation keys are:

- `Tab` / `Shift+Tab` or arrow keys — move focus;
- `Enter` — open the focused destination or activate the current step;
- `Esc` — close the current help/form layer or return toward Overview;
- `?` — open or close keyboard help;
- `r` — refresh the current read surface when refresh is available;
- `g` — open privacy-safe Diagnostics from ordinary and failure surfaces;
- `q` or `Ctrl+C` — request TUI exit.

Forms and confirmation drawers temporarily own the keys required by their current interaction. A mutation is never made retryable merely because a keyboard shortcut exists: outcome-unknown operations remain observation/reconciliation problems rather than blind retry opportunities.

## Narrow terminals and accessibility

EasyServer has both wide and compact layouts. The compact layout is selected below 72 terminal columns and preserves the active destination, canonical selections and focus state across resize.

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

Billable/destructive risk comes from the Provider Plugin command contract but confirmation is host-owned. The TUI shows the target and consequence before dispatch. SSH first-use trust likewise shows the exact discovered fingerprint and requires explicit confirmation; changed trusted keys fail closed.

## Connection lifetime and exit

EasyServer has two different ownership models:

- **Foreground Endpoint** — owned by the current TUI process. It closes when this TUI exits. If foreground Endpoints are still live, the TUI requires a second quit confirmation and closes them before leaving.
- **Daemon-owned persistent Session / Endpoint intent** — owned by the EasyServer daemon and survives TUI exit. Closing the TUI does not silently stop these connections.

The Connections surface keeps desired persisted Endpoint intents separate from live runtime Sessions so disabled/error/recovery state is not confused with an active transport.

## Degraded and recovery states

Healthy TUI sections remain usable when the host can represent a partial failure. Examples include:

- one Provider is unavailable while another has fresh inventory;
- last-known instance observations are stale or a canonical instance is still unobserved;
- a Provider Plugin failed to load while another plugin remains healthy;
- the daemon is stopped, unreachable or has a cleanup-failed retained Session;
- a persisted Endpoint intent failed realization and can be retried safely;
- the primary Local State file is corrupt but a validated recovery generation can be loaded.

If both primary and recovery Local State are invalid, EasyServer fails closed instead of silently resetting or discarding configuration. Diagnostics expose a privacy-safe support payload rather than raw secrets/provider responses.

## Qualified release environment

The `0.2.0` TUI release surface is qualified on **Windows 11 x64** with **Node.js 24.18.1**. Release checks exercise the real terminal path for normal quit, Ctrl+C, resize, compact layout, `NO_COLOR`, screen-reader mode and thrown-error restoration, plus TUI launch from both the packed npm installation and the portable ZIP.

Linux and macOS are not qualified support targets yet. Do not infer a support promise from the fact that the code or Ink may run there; platform expansion is tracked separately and requires its own release-level qualification.
