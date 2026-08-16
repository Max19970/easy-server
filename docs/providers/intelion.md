# Use EasyServer with Intelion.cloud

The Intelion.cloud Provider Plugin keeps Intelion's server catalog/configuration model provider-specific, then exposes created servers through EasyServer's shared lifecycle and local connection workflows.

This guide owns Intelion-specific account preparation, configuration fields, connection credentials, and cleanup semantics.

## Prepare your Intelion.cloud account

You need:

- an Intelion.cloud account with permission/quota for the server configuration you plan to create;
- an Intelion API token.

Registered Intelion SSH public keys are optional provider-side creation inputs. They are **not** the credential EasyServer's normal Intelion SSH tunnel uses in `0.2.x`.

For EasyServer-managed SSH access, the plugin resolves the provider-issued password for that specific server through Intelion's authenticated API **after** SSH host trust succeeds. The configured API token authorizes that lookup but is never sent to OpenSSH as the SSH password itself.

## Install and add the plugin

For a global npm installation:

```powershell
npm install --global @easyai101/easyserver-plugin-intelion
easyserver
```

Then open **Settings & Support → Providers → Add installed provider** and choose **Intelion.cloud**.

If you use the portable GitHub Release ZIP, install the plugin into that extracted EasyServer prefix instead. Follow [Install from GitHub Releases](../github-release-install.md#add-a-provider-plugin-later).

For CLI/automation setup:

```powershell
easyserver plugins add @easyai101/easyserver-plugin-intelion
```

## Configure the API token

The TUI exposes the provider's declared `api-token` credential under its Actions menu and stores the value through EasyServer's OS-backed Secret Store.

For automation, import the token through an environment variable:

```powershell
$env:INTELION_API_TOKEN = '<your-api-token>'
easyserver plugins credential set @easyai101/easyserver-plugin-intelion api-token --env INTELION_API_TOKEN
Remove-Item Env:INTELION_API_TOKEN
```

Check readiness with:

```powershell
easyserver plugins list
```

Before configuration the provider reports `credentials=missing:api-token`; afterward it reports `credentials=ready` without printing the token.

## Create a server

In the TUI, choose **Rent a server** and select Intelion.cloud.

The provider-owned configurator guides you through Intelion's available server choices instead of forcing them into a generic cross-provider create form. Billable creation goes through EasyServer's host-owned confirmation screen.

### Explore the catalog from the CLI

Every configurator command exposes its own help:

```powershell
easyserver provider intelion server-configurator flavors --help
easyserver provider intelion server-configurator os-images --help
easyserver provider intelion server-configurator ssh-keys --help
easyserver provider intelion server-configurator create --help
```

List flavors:

```powershell
easyserver provider intelion server-configurator flavors
```

List OS images:

```powershell
easyserver provider intelion server-configurator os-images
```

Filter images by flavor when useful:

```powershell
easyserver provider intelion server-configurator os-images --flavor <flavor-id>
```

List SSH public-key records already registered with Intelion:

```powershell
easyserver provider intelion server-configurator ssh-keys
```

Use IDs returned by the provider catalog when validating or creating a server.

### Validate before creation

The `0.2.x` configurator requires:

```text
--name <name>
--flavor <id>
--disk <gb>
--os <id>
```

Optional fields include:

```text
--price-plan <id>
--promocode <id>
--queue
--addon <id>       # repeatable
--ssh-key <id>     # repeatable
```

Network disk size must be at least 30 GB in the current plugin contract.

Validate a configuration without creating a paid server:

```powershell
easyserver provider intelion server-configurator validate `
  --name easyserver-demo `
  --flavor <flavor-id> `
  --disk 30 `
  --os <os-image-id>
```

### Create from the CLI

Use the same fields with `create`:

```powershell
easyserver provider intelion server-configurator create `
  --name easyserver-demo `
  --flavor <flavor-id> `
  --disk 30 `
  --os <os-image-id>
```

Interactive command mode asks for billable-operation confirmation. Non-interactive automation must opt in explicitly:

```powershell
easyserver provider intelion server-configurator create --yes `
  --name easyserver-demo `
  --flavor <flavor-id> `
  --disk 30 `
  --os <os-image-id>
```

If EasyServer reports `outcome-unknown`, the create request may already have reached Intelion. Do **not** blindly create another server; reconcile inventory first:

```powershell
easyserver instances list
```

Provider transitions can be asynchronous, so do not assume a newly created server is immediately ready for every lifecycle or connection action.

## Manage the server

After provider refresh observes the server, it appears in **Servers** and in the shared CLI inventory:

```powershell
easyserver instances list
easyserver instances inspect <instance-id>
```

Only use lifecycle actions the current snapshot exposes:

```powershell
easyserver instances start <instance-id>
easyserver instances stop <instance-id>
easyserver instances restart <instance-id>
easyserver instances destroy <instance-id>
```

Provider lifecycle state and billing state are separate. Do not assume `stopped` means the Intelion resource has no remaining charges.

## Connect to a service

When your workload is listening on the server, choose **Connect** from the server in the TUI and enter the workload's application/service port.

CLI example for remote port `8188`:

```powershell
easyserver connect <instance-id> --port 8188
```

EasyServer publishes a local loopback address such as `127.0.0.1:54321` while the connection is active.

### Intelion connection credential behavior

On first SSH-backed access, EasyServer first obtains/reviews the server's SSH host-key fingerprint. Only after host trust succeeds does the plugin request the server-specific password through Intelion's authenticated API.

A failure to retrieve/use that password is therefore distinct from “the API token is missing or rejected”. EasyServer keeps those failure layers separate in connection remediation.

The provider-issued SSH password is not printed and is not persisted as ordinary EasyServer Local State.

See [Connect to a remote service](../connections.md) for the full connection model and [Background connections](../background-connections.md) for daemon-managed access.

## Clean up the server

When you no longer need the paid resource:

1. Close any EasyServer foreground/background connections you no longer need.
2. Destroy the server if your intent is to remove the Intelion cloud resource.
3. Refresh inventory and verify that the provider has converged to the expected terminal/absent state.
4. Only then remove or disable local provider configuration if desired.

```powershell
easyserver instances destroy <instance-id>
easyserver instances list
```

Disabling the plugin, removing the API-token reference, stopping the EasyServer daemon, or merely closing the TUI does **not** destroy the Intelion server.
