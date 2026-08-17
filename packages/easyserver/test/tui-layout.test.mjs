import assert from "node:assert/strict";
import test from "node:test";
import {
  tuiReadableMeasure,
  tuiResourceRow,
  tuiTableColumnWidths,
  tuiTableRow,
  tuiWidthClass,
} from "../dist/tui-layout.js";

test("resource rows keep identity and state scannable at 60, 80 and 120 columns", () => {
  for (const width of [60, 80, 120]) {
    const first = tuiResourceRow({
      marker: "> ",
      primary: "A very long GPU workstation name used to test truncation",
      state: "running",
    }, width);
    const second = tuiResourceRow({
      marker: "  ",
      primary: "Short server",
      state: "stopped",
    }, width);
    assert.equal(first.length, width);
    assert.equal(second.length, width);
    assert.equal(first.indexOf("running"), second.indexOf("stopped"));
    assert.match(first, /^> /);
    if (width === 60) {
      assert.match(first, /…/u);
    }
  }
});

test("compact connection rows preserve target identity before lower-priority detail", () => {
  const row = tuiResourceRow({
    marker: "> ",
    primary: "127.0.0.1:48188",
    secondary: "Very Long Server Identity:8188 · background",
    compactPrimary: "127.0.0.1:48188 → Server:8188",
    state: "live/bg",
  }, 60);
  assert.equal(row.length, 60);
  assert.match(row, /^> 127\.0\.0\.1:48188 → Server:8188/u);
  assert.match(row, /live\/bg\s*$/u);
});

test("provider tables allocate stable columns without exceeding the terminal width", () => {
  const headers = ["GPU", "VRAM", "Location", "Price"];
  const rows = [
    ["RTX 4090", "24 GB", "Finland", "$0.31/h"],
    ["Very Long Accelerator Marketing Name", "48 GB", "United States East", "$1.00/h"],
  ];
  for (const width of [60, 80, 120]) {
    const widths = tuiTableColumnWidths(headers, rows, width, 6);
    const header = tuiTableRow(headers, widths);
    const first = tuiTableRow(rows[0], widths);
    const second = tuiTableRow(rows[1], widths);
    assert.ok(6 + header.length <= width, `${width}: ${header}`);
    assert.equal(first.length, header.length);
    assert.equal(second.length, header.length);
    assert.equal(first.indexOf("$0.31/h"), second.indexOf("$1.00/h"));
    assert.doesNotMatch(first, / · /u);
  }
});

test("wide layouts keep a controlled readable measure", () => {
  assert.equal(tuiWidthClass(60), "compact");
  assert.equal(tuiWidthClass(80), "standard");
  assert.equal(tuiWidthClass(120), "wide");
  assert.equal(tuiReadableMeasure(56), 56);
  assert.equal(tuiReadableMeasure(76), 76);
  assert.equal(tuiReadableMeasure(116), 96);
});
