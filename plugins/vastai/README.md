# @easyai101/easyserver-plugin-vastai

First-party Vast.ai Provider Plugin for EasyServer: marketplace search/rental plus shared EasyServer lifecycle and SSH-backed local connections.

## Install

Install it into the same npm environment as the EasyServer CLI:

```powershell
npm install --global @easyai101/easyserver-plugin-vastai
```

Then run:

```powershell
easyserver
```

Open **Settings & Support → Providers → Add installed provider**, choose **Vast.ai**, and configure the declared API-key credential.

For automation/advanced setup, the installed package can also be registered explicitly:

```powershell
easyserver plugins add @easyai101/easyserver-plugin-vastai
```

The provider requires account preparation for SSH-backed rentals; do not assume a valid API key is also an SSH login identity.

Full provider guide: https://github.com/Max19970/easy-server/blob/main/docs/providers/vastai.md
