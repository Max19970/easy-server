import React from "react";
import { render } from "ink";
import { TuiShell } from "../../dist/tui.js";

const expectedMessage = "TUI operation presentation must come from the presentation model";
const app = render(
  React.createElement(TuiShell, { colorEnabled: false }),
  {
    alternateScreen: true,
    interactive: true,
  },
);

await app.waitUntilRenderFlush();
app.rerender(
  React.createElement(TuiShell, {
    colorEnabled: false,
    operation: { kind: "untrusted-fixture" },
  }),
);

try {
  await app.waitUntilExit();
  throw new Error("TUI error fixture unexpectedly resolved");
} catch (error) {
  if (!(error instanceof Error) || !error.message.includes(expectedMessage)) {
    throw error;
  }
}
