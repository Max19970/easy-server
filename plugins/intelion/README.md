# @easyai101/easyserver-plugin-intelion

First-party Intelion.cloud Provider Plugin for EasyServer: server catalog/configuration and creation plus shared EasyServer lifecycle and SSH-backed local connections.

## Install

Install it into the same npm environment as the EasyServer CLI:

```powershell
npm install --global @easyai101/easyserver-plugin-intelion
```

Then run:

```powershell
easyserver
```

Open **Settings & Support → Providers → Add installed provider**, choose **Intelion.cloud**, and configure the declared API-token credential.

For automation/advanced setup, the installed package can also be registered explicitly:

```powershell
easyserver plugins add @easyai101/easyserver-plugin-intelion
```

EasyServer uses the API token for Intelion API access; its normal SSH connection path resolves the server-specific provider password only after host trust succeeds.

Full provider guide: https://github.com/Max19970/easy-server/blob/main/docs/providers/intelion.md
