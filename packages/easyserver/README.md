# @easyai101/easyserver

EasyServer is a provider-independent CLI for acquiring, managing and locally accessing rented compute.

## Install

```sh
npm install --global @easyai101/easyserver
```

The CLI installs with **zero Provider Plugins**. Providers are opt-in packages selected by the user. For example:

```sh
npm install --global @easyai101/easyserver-plugin-vastai
easyserver plugins add @easyai101/easyserver-plugin-vastai
```

Use `easyserver plugins list` to inspect configured plugins and `easyserver --help` for the command surface.

Full documentation and source: https://github.com/Max19970/easy-server
