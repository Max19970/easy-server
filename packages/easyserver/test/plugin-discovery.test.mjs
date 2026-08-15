import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverInstalledProviderPlugins } from "../dist/plugin-discovery.js";

test("discovers only packages that explicitly advertise safe EasyServer provider metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "easyserver-plugin-discovery-"));
  try {
    const nodeModules = join(root, "node_modules");
    await writePackage(nodeModules, "@fixture/vast", {
      name: "@fixture/vast",
      description: "Fixture provider",
      easyserver: { kind: "provider-plugin", displayName: "Vast Fixture" },
    });
    await writePackage(nodeModules, "plain-package", {
      name: "plain-package",
      keywords: ["easyserver", "provider-plugin"],
    });
    await writePackage(nodeModules, "@fixture/broken", {
      name: "@fixture/broken",
      easyserver: { kind: "provider-plugin", displayName: "" },
    });
    await writePackage(nodeModules, "@fixture/spoof-slot", {
      name: "@fixture/vast",
      easyserver: { kind: "provider-plugin", displayName: "Spoofed Vast" },
    });

    assert.deepEqual(await discoverInstalledProviderPlugins([nodeModules]), [
      {
        source: "@fixture/vast",
        displayName: "Vast Fixture",
        description: "Fixture provider",
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovers workspace-style provider package symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "easyserver-plugin-discovery-link-"));
  try {
    const target = join(root, "provider-target");
    await mkdir(target, { recursive: true });
    await writeFile(
      join(target, "package.json"),
      `${JSON.stringify({
        name: "@fixture/linked-provider",
        easyserver: { kind: "provider-plugin", displayName: "Linked Provider" },
      }, null, 2)}\n`,
      "utf8",
    );
    const nodeModules = join(root, "node_modules");
    const scope = join(nodeModules, "@fixture");
    await mkdir(scope, { recursive: true });
    await symlink(target, join(scope, "linked-provider"), "junction");

    assert.deepEqual(await discoverInstalledProviderPlugins([nodeModules]), [
      { source: "@fixture/linked-provider", displayName: "Linked Provider" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deduplicates package names across module search roots and sorts by display name", async () => {
  const root = await mkdtemp(join(tmpdir(), "easyserver-plugin-discovery-order-"));
  try {
    const first = join(root, "first");
    const second = join(root, "second");
    await writePackage(first, "@fixture/zeta", {
      name: "@fixture/zeta",
      easyserver: { kind: "provider-plugin", displayName: "Zeta" },
    });
    await writePackage(first, "@fixture/alpha", {
      name: "@fixture/alpha",
      easyserver: { kind: "provider-plugin", displayName: "Alpha" },
    });
    await writePackage(second, "@fixture/alpha", {
      name: "@fixture/alpha",
      easyserver: { kind: "provider-plugin", displayName: "Different Alpha" },
    });

    assert.deepEqual(await discoverInstalledProviderPlugins([first, second]), [
      { source: "@fixture/alpha", displayName: "Alpha" },
      { source: "@fixture/zeta", displayName: "Zeta" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writePackage(root, source, metadata) {
  const directory = source.startsWith("@")
    ? join(root, ...source.split("/"))
    : join(root, source);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
}
