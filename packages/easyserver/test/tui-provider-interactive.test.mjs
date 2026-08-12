import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { cleanup, render } from "ink-testing-library";
import { ProviderInteractiveSurface } from "../dist/tui-provider-interactive.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

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
              { id: "balanced", label: "Balanced" },
              { id: "burst", label: "Burst" },
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

  view.stdin.write("j");
  await tick();
  view.stdin.write("j");
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.deepEqual(events.at(-1), {
    kind: "field-change",
    fieldId: "reserved",
    value: true,
  });

  view.stdin.write("j");
  await tick();
  view.stdin.write("\u001b[C");
  await tick();
  assert.deepEqual(events.at(-1), {
    kind: "field-change",
    fieldId: "tier",
    value: "burst",
  });

  view.stdin.write("1");
  await tick();
  assert.deepEqual(events.at(-1), {
    kind: "action",
    actionId: "continue",
  });
  assert.equal(closed, 0);
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
  view.stdin.write("j");
  await tick();
  view.stdin.write("\r");
  await tick();
  assert.deepEqual(events.at(-1), {
    kind: "table-selection",
    rowIds: ["b"],
  });
  view.stdin.write("1");
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
  view.stdin.write("\r");
  await tick();
  assert.deepEqual(events.at(-1), { kind: "action", actionId: "submit" });
});
