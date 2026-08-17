# Interactive TUI

The EasyServer TUI is the preferred interface for ordinary interactive use.

```powershell
easyserver
```

It presents the same provider, lifecycle, credential, trust, and connection capabilities as the host operations behind command mode, but organizes them around user tasks instead of CLI command groups or internal control-plane objects.

Use `easyserver --help` when you need automation, package-management commands, or an advanced command-oriented workflow.

## Home and navigation

Home gives you four practical starting points:

- **Rent a server** — open a guided provider-owned acquisition flow;
- **Servers** — inspect and manage existing compute;
- **Connections** — inspect local and background connections;
- **Settings & Support** — configure providers/credentials and open Diagnostics.

Working screens use the full content area instead of a permanent sidebar. Breadcrumbs show where you are, and `Esc` moves back toward Home.

The normal keyboard vocabulary is intentionally small:

- `↑` / `↓` — move focus;
- `Enter` — open/select/edit the focused item or run the focused action;
- `Esc` — go back or cancel;
- `?` — keyboard help;
- `Ctrl+C` — request exit.

Ordinary flows do not require route-specific letter keys, number shortcuts, or Left/Right action toggles. Routine route/focus changes are communicated by the visible location and focus itself; the shell keeps one contextual keyboard hint and reserves status text for feedback that can change the next decision.

## Add and configure a provider

EasyServer does not bundle Provider Plugins in the core package. Install the provider package first using npm (or into the extracted portable prefix), then open:

**Settings & Support → Providers → Add installed provider**

Discoverable packages appear by human provider name. The picker reads provider metadata without executing an unconfigured provider runtime. If no installed provider package is discoverable, the TUI says so instead of advertising an unavailable picker action; install the package outside EasyServer, then use **Refresh providers**, or use the Advanced module/path action when you already know the provider source.

After adding a provider, open its **Actions** to configure a declared credential, enable/disable it, or remove a credential binding. Credential input is masked and values stay behind the OS-backed Secret Store boundary.

The TUI manages provider configuration, not the npm package lifecycle itself. Installing, updating, and uninstalling provider packages remains a package-manager task.

## Rent a server

Choose **Rent a server** from Home or Servers. If no guided acquisition workflow is currently available, **Actions → Open Providers** takes you directly to the prerequisite provider setup instead of leaving you at a dead end.

The provider owns the fields and choices in its acquisition flow; EasyServer core renders the generic interaction model. This lets Vast.ai expose marketplace filters and lets Intelion.cloud expose its catalog/configurator without either provider leaking hard-coded fields into core.

Billable operations open a dedicated confirmation screen. The safe Cancel choice is focused first, so an accidental first `Enter` cannot approve the mutation.

Use the provider guide when you need to understand provider-specific options or cleanup semantics:

- [Vast.ai](providers/vastai.md)
- [Intelion.cloud](providers/intelion.md)

## Manage servers

**Servers** is the shared lifecycle surface after provider acquisition.

Rows prioritize a human server name and current state. Technical provider/canonical IDs are available under **Technical details** instead of occupying the primary view.

Select a server and open **Actions** to run only lifecycle operations the current provider snapshot declares as available, such as:

- Start server;
- Stop server;
- Restart server;
- Destroy server;
- Connect.

A server visible through a provider account may be discovered without being under EasyServer destructive management. Destructive operations remain governed by EasyServer's management/safety rules; technical ownership details are available when you need to inspect them.

One provider failing does not hide healthy inventory from another provider. Stale/unobserved information is shown as degraded state rather than silently treated as current.

## Connect to an application/service

Select a server and choose **Connect**. If no server is available yet, **Connections → Actions → Rent a server** routes directly to the prerequisite instead of opening a connection flow that cannot succeed.

The normal flow asks for the application/service TCP port on the server — for example `8188` — and an optional local port. It does not ask a novice to choose an SSH port or connection-method ID.

On success you get a local loopback address such as:

```text
127.0.0.1:40123 → My server:8188
```

Connections opened by the current TUI close when that TUI exits. Background connections can survive the TUI and are clearly marked as background.

Exact remote-host and connection-method selection remain available through Advanced/technical flows. For the complete model, see [Connect to a remote service](connections.md).

## Review first-use SSH trust

When an SSH-backed route needs first-use trust, EasyServer shows the exact host, port, key type, and SHA-256 fingerprint. The trust screen starts on **Decline**.

If you approve it, EasyServer revalidates the reviewed key before enrollment. If the fingerprint changes during review, nothing is trusted and the TUI asks you to review the new evidence again. A changed key for an already trusted host remains a separate fail-closed error.

Saved background connections blocked on host trust expose **Review SSH fingerprint** under their technical details. Approving the evidence retries that same saved definition rather than requiring a throwaway foreground connection.

EasyServer's SSH trust store is separate from the trust accepted by an independent `ssh` command.

## Recover connection failures

Connections keeps failures actionable rather than reducing them to a generic “server unavailable” message.

Depending on the cause, a failure can offer actions such as:

- **Review SSH fingerprint**;
- **Retry connection**;
- **Edit service port**;
- **Edit local port**;
- **Open Diagnostics**.

EasyServer distinguishes major layers such as SSH authentication, changed host identity, missing fingerprint evidence, SSH transport failure, forwarding being forbidden by the SSH server, a remote application port being unavailable, and a local port conflict.

Late failures remain visible even if the local listener was published before a client first used it. Retrying reuses the retained request, and editing one port preserves the other connection fields.

## Background connections

Connections created through the local daemon can continue after the current TUI closes. Saved connection definitions can also be recreated after daemon restart.

The primary Connections view keeps the user-facing local-address model simple; Session IDs, saved Endpoint-intent state, daemon health, and connection-method details remain available under Technical details.

See [Background connections](background-connections.md) for the CLI model, daemon lifecycle, idempotency, saved definitions, and recovery.

## Diagnostics

Open **Settings & Support → Diagnostics** for a privacy-safe health/support summary.

**View report** opens the complete sanitized report in a bounded viewer. In visual mode, long lines wrap to the terminal width and `↑` / `↓` scroll through the rendered rows while the position/action footer remains reachable.

**Copy report** copies the same sanitized payload you review; scrolling and wrapping do not change the copied data.

Diagnostics intentionally does not substitute raw logs or arbitrary OpenSSH stderr, which may contain sensitive provider or credential-adjacent data.

## Narrow terminals and accessibility

EasyServer keeps focused items and actions inside the available terminal viewport instead of rendering long lists below the screen. The current page and logical selection survive terminal resize.

For a linear screen-reader-oriented presentation:

```powershell
$env:INK_SCREEN_READER = 'true'
easyserver
Remove-Item Env:INK_SCREEN_READER
```

Screen-reader mode avoids the alternate screen and emits the relevant route, focus, content, and command state as linear terminal text.

Suppress ANSI foreground colors with:

```powershell
$env:NO_COLOR = '1'
easyserver
Remove-Item Env:NO_COLOR
```

Both options can be used together.

## Interactive terminal requirement

Plain `easyserver` means “open the TUI”. If stdin/stdout are not interactive terminals, the no-argument command fails clearly instead of emitting alternate-screen control output into a pipe or CI log.

Use an explicit command in non-interactive contexts:

```powershell
easyserver --help
easyserver --version
easyserver instances list
```

The exact platform/runtime support boundary lives in [Supported platforms](supported-platforms.md).
