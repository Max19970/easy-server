import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { cleanup, render } from "ink-testing-library";
import { ProviderInteractiveSurface } from "../dist/tui-provider-interactive.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const flushEscape = () => new Promise((resolve) => setTimeout(resolve, 30));
const frameRows = (view) => view.lastFrame().split("\n").length;

test.afterEach(() => cleanup());

test("generic provider form edits provider-owned fields without domain-specific rendering", async () => {
  const events = [];
  let closed = 0;
  const view = render(
    React.createElement(ProviderInteractiveSurface, {
      colorEnabled: false,
      screen: {
        kind: "form",
        id: "configure",
        title: "Configure Nebula allocation",
        description: "Provider-owned values",
        fields: [
          {
            kind: "text",
            id: "region",
            label: "Region",
            required: true,
            value: "eu-north",
          },
          {
            kind: "integer",
            id: "replicas",
            label: "Replicas",
            required: true,
            value: 2,
          },
          {
            kind: "boolean",
            id: "reserved",
            label: "Reserved",
            required: false,
            value: false,
          },
          {
            kind: "single-choice",
            id: "tier",
            label: "Tier",
            required: true,
            choices: [
              { id: "balanced", label: "Balanced", description: "Balanced price and capacity" },
              { id: "burst", label: "Burst", description: "Highest short-term capacity" },
            ],
            value: "balanced",
          },
        ],
        actions: [{ id: "continue", label: "Continue", kind: "primary" }],
      },
      onEvent(event) {
        events.push(event);
      },
      onClose() {
        closed += 1;
      },
    }),
  );

  assert.match(view.lastFrame(), /Configure Nebula allocation/);
  assert.match(view.lastFrame(), /> Region.*eu-north/);
  assert.match(view.lastFrame(), /Replicas.*2/);
  assert.doesNotMatch(view.lastFrame(), /GPU|flavor|image|queue|runtype/i);

  view.stdin.write("\r");
  await tick();
  view.stdin.write("-west");
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.deepEqual(events.at(-1), {
    kind: "field-change",
    fieldId: "region",
    value: "eu-north-west",
  });

  view.stdin.write("\u001b[B");
  await tick();
  view.stdin.write("\u001b[B");
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.deepEqual(events.at(-1), {
    kind: "field-change",
    fieldId: "reserved",
    value: true,
  });

  view.stdin.write("\u001b[B");
  await tick();
  assert.match(view.lastFrame(), /> Tier.*Balanced/);
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /Choose Tier/);
  assert.match(view.lastFrame(), /> \[x\] Balanced/);
  assert.match(view.lastFrame(), /Balanced price and capacity/);
  view.stdin.write("\u001b[B");
  await tick();
  assert.match(view.lastFrame(), /> \[ \] Burst/);
  assert.match(view.lastFrame(), /Highest short-term capacity/);
  view.stdin.write("\r");
  await tick();
  assert.deepEqual(events.at(-1), {
    kind: "field-change",
    fieldId: "tier",
    value: "burst",
  });
  assert.doesNotMatch(view.lastFrame(), /Choose Tier/);

  view.stdin.write("\u001b[B");
  await tick();
  assert.match(view.lastFrame(), /> Continue/);
  view.stdin.write("\r");
  await tick();
  assert.deepEqual(events.at(-1), {
    kind: "action",
    actionId: "continue",
  });
  assert.equal(closed, 0);
});

test("generic provider validation keeps explicit invalid and pending text semantics", async () => {
  const view = render(
    React.createElement(ProviderInteractiveSurface, {
      colorEnabled: false,
      screen: {
        kind: "form",
        id: "validation",
        title: "Validate provider setup",
        fields: [
          {
            kind: "text",
            id: "region",
            label: "Region",
            required: true,
            value: "invalid-region",
            validation: { state: "invalid", message: "Region is unavailable" },
          },
          {
            kind: "text",
            id: "image",
            label: "Image",
            required: true,
            value: "checking",
            validation: { state: "pending" },
          },
        ],
        actions: [],
      },
      onEvent() {},
      onClose() {},
    }),
  );

  assert.match(view.lastFrame(), /> Region \*/);
  assert.match(view.lastFrame(), /Invalid: Region is unavailable/);
  view.stdin.write("\u001b[B");
  await tick();
  assert.match(view.lastFrame(), /> Image \*/);
  assert.match(view.lastFrame(), /Validating…/);
});

test("generic optional numeric fields can be cleared back to undefined", async () => {
  const events = [];
  const view = render(
    React.createElement(ProviderInteractiveSurface, {
      colorEnabled: false,
      screen: {
        kind: "form",
        id: "advanced",
        title: "Advanced provider IDs",
        fields: [
          {
            kind: "integer",
            id: "promotion",
            label: "Promotion ID",
            required: false,
            value: 3,
          },
        ],
        actions: [],
      },
      onEvent(event) {
        events.push(event);
      },
      onClose() {},
    }),
  );

  view.stdin.write("\r");
  await tick();
  view.stdin.write("\u007f");
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.deepEqual(events.at(-1), {
    kind: "field-change",
    fieldId: "promotion",
    value: undefined,
  });
});

test("generic provider table supports provider-owned selection and review submits by action", async () => {
  const events = [];
  const view = render(
    React.createElement(ProviderInteractiveSurface, {
      colorEnabled: false,
      screen: {
        kind: "table",
        id: "results",
        title: "Nebula offers",
        columns: [
          { id: "name", label: "Name" },
          { id: "price", label: "Price" },
        ],
        rows: [
          { id: "a", cells: { name: "Alpha", price: 1.25 } },
          { id: "b", cells: { name: "Beta", price: 2.5 } },
        ],
        selection: "single",
        selectedRowIds: [],
        actions: [{ id: "continue", label: "Continue", kind: "primary" }],
      },
      onEvent(event) {
        events.push(event);
      },
      onClose() {},
    }),
  );

  assert.match(view.lastFrame(), /Nebula offers/);
  assert.match(view.lastFrame(), /Alpha.*1.25/);
  view.stdin.write("\u001b[B");
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.deepEqual(events.at(-1), {
    kind: "table-selection",
    rowIds: ["b"],
  });
  view.stdin.write("\u001b[B");
  await tick();
  assert.match(view.lastFrame(), /> Continue/);
  view.stdin.write("\r");
  await tick();
  assert.deepEqual(events.at(-1), { kind: "action", actionId: "continue" });

  view.rerender(
    React.createElement(ProviderInteractiveSurface, {
      colorEnabled: false,
      screen: {
        kind: "review",
        id: "review",
        title: "Review allocation",
        items: [
          { label: "Offer", value: "Beta" },
          { label: "Price", value: "$2.50/hour" },
        ],
        actions: [
          { id: "back", label: "Back", kind: "back" },
          { id: "submit", label: "Provision", kind: "submit" },
        ],
      },
      onEvent(event) {
        events.push(event);
      },
      onClose() {},
    }),
  );
  await tick();
  assert.match(view.lastFrame(), /Review allocation/);
  assert.match(view.lastFrame(), /> Back/);
  view.stdin.write("\u001b[B");
  await tick();
  assert.match(view.lastFrame(), /> Provision/);
  view.stdin.write("\r");
  await tick();
  assert.deepEqual(events.at(-1), { kind: "action", actionId: "submit" });
});

test("generic provider review keeps overflow items reachable and screen-reader complete", async () => {
  const items = Array.from({ length: 12 }, (_, index) => ({
    label: `Review ${index + 1}`,
    value: index === 11 ? "CRITICAL PRICE $99/hr" : `Value ${index + 1}`,
  }));
  const screen = {
    kind: "review",
    id: "long-review",
    title: "Review provider allocation",
    items,
    actions: [
      { id: "back", label: "Back", kind: "back" },
      { id: "submit", label: "Provision", kind: "submit" },
    ],
  };
  const view = render(
    React.createElement(ProviderInteractiveSurface, {
      colorEnabled: false,
      height: 11,
      screen,
      onEvent() {},
      onClose() {},
    }),
  );

  await tick();
  assert.match(view.lastFrame(), /Review 1: Value 1/);
  assert.doesNotMatch(view.lastFrame(), /CRITICAL PRICE/);
  assert.match(view.lastFrame(), /↓ \d+ more review items/);
  assert.match(view.lastFrame(), /> Back/);
  assert.ok(frameRows(view) <= 11);

  view.stdin.write("\u001b[A");
  await tick();
  assert.match(view.lastFrame(), /> Review 12: CRITICAL PRICE \$99\/hr/);
  assert.match(view.lastFrame(), /↑ \d+ more review items/);
  assert.ok(frameRows(view) <= 11);

  view.stdin.write("\u001b[B");
  await tick();
  assert.match(view.lastFrame(), /> Back/);

  view.rerender(
    React.createElement(ProviderInteractiveSurface, {
      colorEnabled: false,
      height: 11,
      screenReader: true,
      screen,
      onEvent() {},
      onClose() {},
    }),
  );
  await tick();
  assert.match(view.lastFrame(), /Review 1: Value 1/);
  assert.match(view.lastFrame(), /Review 12: CRITICAL PRICE \$99\/hr/);
  assert.match(view.lastFrame(), /> Back/);
});

test("generic provider forms and choice pickers honor the supplied row budget", async () => {
  const fields = Array.from({ length: 30 }, (_, index) => ({
    kind: "text",
    id: `field-${index + 1}`,
    label: `Field ${index + 1}`,
    description: `Long provider-owned description for field ${index + 1}`,
    required: false,
    value: `value-${index + 1}`,
  }));
  const view = render(
    React.createElement(ProviderInteractiveSurface, {
      colorEnabled: false,
      height: 12,
      screen: {
        kind: "form",
        id: "many-fields",
        title: "Many fields",
        description: "Provider-owned form description",
        fields,
        actions: [{ id: "continue", label: "Continue", kind: "primary" }],
      },
      onEvent() {},
      onClose() {},
    }),
  );

  assert.match(view.lastFrame(), /> Field 1/);
  assert.ok(frameRows(view) <= 12);
  for (let index = 0; index < 15; index += 1) {
    view.stdin.write("\u001b[B");
    await tick();
  }
  assert.match(view.lastFrame(), /> Field 16/);
  assert.match(view.lastFrame(), /↑ \d+ more/);
  assert.match(view.lastFrame(), /↓ \d+ more/);
  assert.ok(frameRows(view) <= 12);

  view.rerender(
    React.createElement(ProviderInteractiveSurface, {
      colorEnabled: false,
      height: 12,
      screen: {
        kind: "form",
        id: "many-choices",
        title: "Many choices",
        fields: [
          {
            kind: "single-choice",
            id: "gpu",
            label: "GPU",
            description: "Choose one provider-owned GPU",
            required: false,
            choices: Array.from({ length: 30 }, (_, index) => ({
              id: `gpu-${index + 1}`,
              label: `GPU ${index + 1}`,
              description: `GPU ${index + 1} provider description`,
            })),
          },
        ],
        actions: [],
      },
      onEvent() {},
      onClose() {},
    }),
  );
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /Choose GPU/);
  assert.match(view.lastFrame(), /> \[ \] GPU 1/);
  assert.ok(frameRows(view) <= 12);
  for (let index = 0; index < 15; index += 1) {
    view.stdin.write("\u001b[B");
    await tick();
  }
  assert.match(view.lastFrame(), /> \[ \] GPU 16/);
  assert.match(view.lastFrame(), /↑ \d+ more/);
  assert.match(view.lastFrame(), /↓ \d+ more/);
  assert.ok(frameRows(view) <= 12);
});

test("choice picker is complete for screen readers and preserves multiple selection semantics", async () => {
  const events = [];
  const choices = Array.from({ length: 13 }, (_, index) => ({
    id: `choice-${index + 1}`,
    label: `Choice ${index + 1}`,
    ...(index === 12 ? { disabled: true } : {}),
  }));
  const screen = {
    kind: "form",
    id: "screen-reader-choices",
    title: "Accessible choices",
    fields: [
      {
        kind: "multiple-choice",
        id: "targets",
        label: "Targets",
        required: false,
        choices,
        value: ["choice-2"],
      },
    ],
    actions: [],
  };
  const view = render(
    React.createElement(ProviderInteractiveSurface, {
      colorEnabled: false,
      height: 8,
      screenReader: true,
      screen,
      onEvent(event) {
        events.push(event);
      },
      onClose() {},
    }),
  );

  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /Choose Targets/);
  assert.match(view.lastFrame(), /Choice 1/);
  assert.match(view.lastFrame(), /> \[x\] Choice 2/);
  assert.match(view.lastFrame(), /Choice 12/);
  assert.doesNotMatch(view.lastFrame(), /Choice 13/);
  assert.doesNotMatch(view.lastFrame(), /\d+ more/);

  view.stdin.write("\u001b[B");
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.deepEqual(events.at(-1), {
    kind: "field-change",
    fieldId: "targets",
    value: ["choice-2", "choice-3"],
  });
  assert.match(view.lastFrame(), /Choose Targets/);
  view.stdin.write("\u001b");
  await flushEscape();
  assert.doesNotMatch(view.lastFrame(), /Choose Targets/);
});

test("visual choice picker keeps long provider labels bounded across resize", async () => {
  const hostileLabel = `Provider GPU \u001b[31m${"X".repeat(240)}`;
  const choices = Array.from({ length: 50 }, (_, index) => ({
    id: `gpu-${index + 1}`,
    label: `${hostileLabel}-${index + 1}`,
    description: `Provider description ${index + 1}`,
  }));
  const screen = {
    kind: "form",
    id: "long-choices",
    title: "Long provider choices",
    fields: [
      {
        kind: "single-choice",
        id: "gpu",
        label: "GPU",
        required: false,
        choices,
      },
    ],
    actions: [],
  };
  const renderSurface = (height) =>
    React.createElement(ProviderInteractiveSurface, {
      colorEnabled: false,
      height,
      screen,
      onEvent() {},
      onClose() {},
    });
  const view = render(renderSurface(20));
  Object.defineProperty(view.stdout, "columns", { value: 60, configurable: true });
  view.stdout.emit("resize");
  await tick();

  view.stdin.write("\r");
  await tick();
  assert.match(view.lastFrame(), /> \[ \] Provider GPU \\u001b\[31m/);
  assert.match(view.lastFrame(), /↓ \d+ more/);
  assert.match(view.lastFrame(), /↑\/↓ move · Enter choose · Esc back/);
  assert.ok(frameRows(view) <= 20, `start frame exceeded height: ${frameRows(view)}`);

  for (let index = 0; index < 24; index += 1) {
    view.stdin.write("\u001b[B");
    await tick();
  }
  assert.match(view.lastFrame(), /> \[ \] Provider GPU \\u001b\[31m.*-25/);
  assert.match(view.lastFrame(), /↑ \d+ more/);
  assert.match(view.lastFrame(), /↓ \d+ more/);
  assert.ok(frameRows(view) <= 20, `middle frame exceeded height: ${frameRows(view)}`);

  view.rerender(renderSurface(16));
  await tick();
  assert.match(view.lastFrame(), /> \[ \] Provider GPU \\u001b\[31m.*-25/);
  assert.match(view.lastFrame(), /↑\/↓ move · Enter choose · Esc back/);
  assert.ok(frameRows(view) <= 16, `resized frame exceeded height: ${frameRows(view)}`);
});

test("generic provider tables keep focused rows inside a bounded terminal viewport", async () => {
  const rows = Array.from({ length: 50 }, (_, index) => ({
    id: `offer-${index + 1}`,
    cells: { name: `Offer ${index + 1}`, price: index + 1 },
  }));
  const view = render(
    React.createElement(ProviderInteractiveSurface, {
      colorEnabled: false,
      height: 12,
      screen: {
        kind: "table",
        id: "many-results",
        title: "Many offers",
        columns: [
          { id: "name", label: "Name" },
          { id: "price", label: "Price" },
        ],
        rows,
        selection: "single",
        selectedRowIds: [],
        actions: [{ id: "continue", label: "Continue", kind: "primary" }],
      },
      onEvent() {},
      onClose() {},
    }),
  );

  assert.match(view.lastFrame(), /> \[ \] Offer 1/);
  assert.match(view.lastFrame(), /↓ \d+ more offers/);
  assert.doesNotMatch(view.lastFrame(), /Offer 50/);
  assert.ok(frameRows(view) <= 12, `start frame exceeded height: ${frameRows(view)}`);

  for (let index = 0; index < 24; index += 1) {
    view.stdin.write("\u001b[B");
    await tick();
  }
  assert.match(view.lastFrame(), /> \[ \] Offer 25/);
  assert.match(view.lastFrame(), /↑ \d+ more offers/);
  assert.match(view.lastFrame(), /↓ \d+ more offers/);
  assert.ok(frameRows(view) <= 12, `middle frame exceeded height: ${frameRows(view)}`);

  for (let index = 24; index < 49; index += 1) {
    view.stdin.write("\u001b[B");
    await tick();
  }

  assert.match(view.lastFrame(), /> \[ \] Offer 50/);
  assert.match(view.lastFrame(), /↑ \d+ more offers/);
  assert.doesNotMatch(view.lastFrame(), /Offer 1 · 1/);
  assert.ok(frameRows(view) <= 12, `end frame exceeded height: ${frameRows(view)}`);

  view.stdin.write("\u001b[B");
  await tick();
  assert.match(view.lastFrame(), /> Continue/);
  assert.ok(frameRows(view) <= 12, `action frame exceeded height: ${frameRows(view)}`);
  view.stdin.write("\u001b[B");
  await tick();
  assert.match(view.lastFrame(), /> Continue/);
});
