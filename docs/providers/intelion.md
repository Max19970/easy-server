# Intelion.cloud Provider Plugin

The first-party Intelion.cloud integration is maintained and released independently from EasyServer.

- Repository and provider-owned documentation: https://github.com/Max19970/easy-server-plugin-intelion
- npm package: `@easyai101/easyserver-plugin-intelion`

Install the plugin into the same npm environment or portable prefix as EasyServer, then add it through **Settings & Support → Providers → Add installed provider** or:

```powershell
easyserver plugins add @easyai101/easyserver-plugin-intelion
```

EasyServer validates the plugin's declared host and Plugin SDK compatibility ranges when loading it. The plugin package version is independent from the EasyServer package version.
