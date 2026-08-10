# @easycompute/cli

EasyCompute is a provider-independent CLI for acquiring, managing and locally accessing rented compute.

## Install

```sh
npm install --global @easycompute/cli
```

The CLI installs with **zero Provider Plugins**. Providers are opt-in packages selected by the user. For example:

```sh
npm install --global @easycompute/plugin-vastai
easycompute plugins add @easycompute/plugin-vastai
```

Use `easycompute plugins list` to inspect configured plugins and `easycompute --help` for the command surface.

Full documentation and source: https://github.com/Max19970/easy-compute
