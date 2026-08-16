import assert from "node:assert/strict";
import test from "node:test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { renderReleaseNotes } from "./render-release-notes.mjs";

const context = {
  sourcePath: "docs/releases/v0.2.1.md",
  repository: "Max19970/easy-server",
  ref: "0123456789abcdef0123456789abcdef01234567",
};
const blob = `https://github.com/${context.repository}/blob/${context.ref}`;

test("release-note renderer pins repository-relative links to the tagged commit", () => {
  const source = [
    "[Docs](../getting-started.md)",
    "[History](v0.2.0.md)",
    "[Section](../tui.md#keys)",
    "[Here](#details)",
    "[Site](https://example.com/x)",
    "[Mail](mailto:maintainer@example.com)",
    "[Protocol](//example.com/x)",
    "",
  ].join("\n");

  assert.equal(
    renderReleaseNotes(source, context),
    [
      `[Docs](${blob}/docs/getting-started.md)`,
      `[History](${blob}/docs/releases/v0.2.0.md)`,
      `[Section](${blob}/docs/tui.md#keys)`,
      "[Here](#details)",
      "[Site](https://example.com/x)",
      "[Mail](mailto:maintainer@example.com)",
      "[Protocol](//example.com/x)",
      "",
    ].join("\n"),
  );
});

test("release-note renderer preserves link titles while emitting valid Markdown", () => {
  const rendered = renderReleaseNotes('[Docs](<../getting-started.md> "Guide")', context);
  const [link] = nodesOfType(rendered, "link");
  assert.equal(link.url, `${blob}/docs/getting-started.md`);
  assert.equal(link.title, "Guide");
});

test("release-note renderer rewrites reference-style relative destinations", () => {
  const source = [
    "[Docs][docs]",
    "[History][history]",
    "[External][external]",
    "[Wrapped][wrapped]",
    "",
    '[docs]: ../getting-started.md "Guide"',
    "[history]: <v0.2.0.md>",
    "[external]: https://example.com/docs",
    "[wrapped]:",
    " ../connections.md",
    "",
  ].join("\n");

  const rendered = renderReleaseNotes(source, context);
  const definitions = Object.fromEntries(
    nodesOfType(rendered, "definition").map((node) => [node.identifier, node]),
  );
  assert.equal(definitions.docs.url, `${blob}/docs/getting-started.md`);
  assert.equal(definitions.docs.title, "Guide");
  assert.equal(definitions.history.url, `${blob}/docs/releases/v0.2.0.md`);
  assert.equal(definitions.external.url, "https://example.com/docs");
  assert.equal(definitions.wrapped.url, `${blob}/docs/connections.md`);
});

test("release-note renderer leaves Markdown-looking code examples unchanged", () => {
  const source = [
    "`[inline](../getting-started.md)`",
    "`before",
    "[multiline](../getting-started.md)",
    "after`",
    "",
    "```md",
    "[fenced](../getting-started.md)",
    "```",
    "",
    "    [indented](../getting-started.md)",
    "[real](../getting-started.md)",
  ].join("\n");

  assert.equal(
    renderReleaseNotes(source, context),
    source.replace(
      "[real](../getting-started.md)",
      `[real](${blob}/docs/getting-started.md)`,
    ),
  );
});

test("release-note renderer follows CommonMark link structure instead of indentation heuristics", () => {
  const source = [
    "- Parent",
    "    - [Nested [label]](",
    "      ../getting-started.md)",
    "",
    "    [Nested paragraph](../connections.md)",
    "",
  ].join("\n");

  const rendered = renderReleaseNotes(source, context);
  assert.deepEqual(
    nodesOfType(rendered, "link").map((node) => node.url),
    [`${blob}/docs/getting-started.md`, `${blob}/docs/connections.md`],
  );
  assert.match(rendered, /^- Parent/mu);
});

test("release-note renderer handles code spans in link labels", () => {
  for (const source of [
    "[`[`](../getting-started.md)",
    "[`](`](../getting-started.md)",
  ]) {
    const rendered = renderReleaseNotes(source, context);
    const [link] = nodesOfType(rendered, "link");
    assert.equal(link.url, `${blob}/docs/getting-started.md`);
  }
});

test("release-note renderer re-escapes normalized CommonMark destinations safely", () => {
  const source = [
    "[space](../foo&#x20;bar.md)",
    "[escaped](../foo\\(bar.md)",
    "[angle](<../foo&#62;bar.md>)",
    "[paren-ref][paren]",
    "",
    "[paren]: ../foo&#41;bar.md",
    "",
  ].join("\n");
  const rendered = renderReleaseNotes(source, context);

  assert.deepEqual(
    nodesOfType(rendered, "link").map((node) => node.url),
    [
      `${blob}/docs/foo bar.md`,
      `${blob}/docs/foo(bar.md`,
      `${blob}/docs/foo>bar.md`,
    ],
  );
  const [definition] = nodesOfType(rendered, "definition");
  assert.equal(definition.url, `${blob}/docs/foo)bar.md`);
});

test("release-note renderer rejects literal and encoded repository traversal", () => {
  for (const destination of [
    "../../../outside.md",
    "%2e%2e/%2e%2e/%2e%2e/outside.md",
    "%252e%252e/%252e%252e/%252e%252e/outside.md",
  ]) {
    assert.throws(
      () => renderReleaseNotes(`[Outside](${destination})`, context),
      /escapes the repository/u,
    );
  }
});

function nodesOfType(markdown, type) {
  const found = [];
  walk(fromMarkdown(markdown), (node) => {
    if (node.type === type) {
      found.push(node);
    }
  });
  return found;
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) {
    walk(child, visit);
  }
}
