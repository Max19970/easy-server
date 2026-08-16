# @easyai101/easyserver

EasyServer is the CLI/TUI package for renting and managing provider compute, then exposing remote TCP services on local `127.0.0.1` addresses.

## Install

```powershell
npm install --global @easyai101/easyserver
```

Run the interactive TUI:

```powershell
easyserver
```

Open the automation/advanced CLI hierarchy:

```powershell
easyserver --help
```

The core package installs with **zero Provider Plugins**. Add only the providers you want, for example:

```powershell
npm install --global @easyai101/easyserver-plugin-vastai
```

Then run `easyserver` and use **Settings & Support → Providers → Add installed provider**, or register the package explicitly from command mode.

Project documentation:

- [README](https://github.com/Max19970/easy-server#readme)
- [Русская документация](https://github.com/Max19970/easy-server/blob/main/README.ru.md)
- [Getting started](https://github.com/Max19970/easy-server/blob/main/docs/getting-started.md)
- [Documentation index](https://github.com/Max19970/easy-server/blob/main/docs/README.md)
