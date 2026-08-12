import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "ink" ||
      specifier === "react" ||
      specifier === "react/jsx-runtime" ||
      specifier === "react/jsx-dev-runtime"
    ) {
      throw new Error(`TUI runtime must stay lazy for command mode: ${specifier}`);
    }
    return nextResolve(specifier, context);
  },
});
