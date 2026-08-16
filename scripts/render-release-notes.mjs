import { readFile, writeFile } from "node:fs/promises";
import { posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";

const uriScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const rewriteableNodeTypes = new Set(["link", "image", "definition"]);

export function renderReleaseNotes(markdown, { sourcePath, repository, ref }) {
  assertRepositoryPath(sourcePath);
  assertRepository(repository);
  assertRef(ref);

  const tree = fromMarkdown(markdown);
  const changed = new Set();

  walk(tree, (node) => {
    if (!rewriteableNodeTypes.has(node.type) || typeof node.url !== "string") {
      return;
    }
    const rewritten = rewriteDestination(node.url, sourcePath, repository, ref);
    if (rewritten !== node.url) {
      node.url = rewritten;
      changed.add(node);
    }
  });

  const patches = [];
  collectTopLevelPatches(tree, changed, patches);

  let rendered = markdown;
  for (const patch of patches.sort((left, right) => right.start - left.start)) {
    rendered =
      rendered.slice(0, patch.start) + patch.replacement + rendered.slice(patch.end);
  }
  return rendered;
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) {
    walk(child, visit);
  }
}

function collectTopLevelPatches(node, changed, patches) {
  if (changed.has(node)) {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new Error(`Markdown ${node.type} is missing source offsets`);
    }
    patches.push({
      start,
      end,
      replacement: serializeNode(node),
    });
    return;
  }

  for (const child of node.children ?? []) {
    collectTopLevelPatches(child, changed, patches);
  }
}

function serializeNode(node) {
  const rendered = toMarkdown({ type: "root", children: [node] });
  return rendered.endsWith("\n") ? rendered.slice(0, -1) : rendered;
}

function rewriteDestination(destination, sourcePath, repository, ref) {
  if (
    destination.length === 0 ||
    destination.startsWith("#") ||
    destination.startsWith("//") ||
    destination.startsWith("/") ||
    uriScheme.test(destination)
  ) {
    return destination;
  }

  const splitAt = destination.search(/[?#]/u);
  const path = splitAt === -1 ? destination : destination.slice(0, splitAt);
  const tail = splitAt === -1 ? "" : destination.slice(splitAt);
  if (path.length === 0) {
    return destination;
  }

  assertNoEncodedTraversal(path, destination);
  const resolvedPath = posix.normalize(posix.join(posix.dirname(sourcePath), path));
  if (resolvedPath === ".." || resolvedPath.startsWith("../")) {
    throw new Error(`Release-note link escapes the repository: ${destination}`);
  }

  const rendered = `https://github.com/${repository}/blob/${ref}/${resolvedPath}${tail}`;
  const releaseRoot = new URL(`https://github.com/${repository}/blob/${ref}/`);
  const renderedUrl = new URL(rendered);
  if (
    renderedUrl.origin !== releaseRoot.origin ||
    !renderedUrl.pathname.startsWith(releaseRoot.pathname)
  ) {
    throw new Error(`Release-note link escapes the repository: ${destination}`);
  }
  return rendered;
}

function assertNoEncodedTraversal(path, destination) {
  for (const segment of path.split("/")) {
    if (!segment.includes("%")) {
      continue;
    }
    let decoded = segment;
    for (let pass = 0; pass < 3; pass += 1) {
      let next;
      try {
        next = decodeURIComponent(decoded);
      } catch {
        throw new Error(`Release-note link has invalid encoding: ${destination}`);
      }
      if (next === decoded) {
        break;
      }
      decoded = next;
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\")
    ) {
      throw new Error(`Release-note link escapes the repository: ${destination}`);
    }
  }
}

function assertRepositoryPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value === ".." ||
    value.startsWith("../") ||
    value.includes("\\")
  ) {
    throw new TypeError("sourcePath must be a repository-relative POSIX path");
  }
}

function assertRepository(value) {
  if (typeof value !== "string" || !/^[^/\s]+\/[^/\s]+$/u.test(value)) {
    throw new TypeError("repository must use owner/name form");
  }
}

function assertRef(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/iu.test(value)) {
    throw new TypeError("ref must be a full Git commit SHA");
  }
}

async function main() {
  const [sourceFile, outputFile, repository, ref] = process.argv.slice(2);
  if (!sourceFile || !outputFile || !repository || !ref) {
    throw new Error(
      "Usage: node scripts/render-release-notes.mjs <source> <output> <owner/name> <commit-sha>",
    );
  }

  const sourceAbsolute = resolve(sourceFile);
  const sourcePath = relative(process.cwd(), sourceAbsolute).replaceAll("\\", "/");
  const markdown = await readFile(sourceAbsolute, "utf8");
  const rendered = renderReleaseNotes(markdown, { sourcePath, repository, ref });
  await writeFile(resolve(outputFile), rendered, "utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
