import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadProviderCliHelp,
  providerHelpSpecifier,
} from "../dist/provider-cli-help.js";
import { JsonStateStore } from "../dist/state-store.js";

const testDirectory = await mkdtemp(join(tmpdir(), "easyserver-provider-help-"));

test.after(async () => {
  await rm(testDirectory, { recursive: true, force: true });
});

test("provider help uses only the dedicated package subpath and never the normal plugin entrypoint", async () => {
  const stateFile = join(testDirectory, "state.json");
  await new JsonStateStore(stateFile).write({
    version: 1,
    plugins: [
      {
        source: "@fixture/provider",
        enabled: true,
        credentials: [
          {
            name: "api-key",
            secretRef: "secret:550e8400-e29b-41d4-a716-446655440000",
          },
        ],
      },
    ],
  });

  const imported = [];
  const contribution = await loadProviderCliHelp("fixture", {
    stateFile,
    async importer(specifier) {
      imported.push(specifier);
      assert.equal(specifier, "@fixture/provider/easyserver-help");
      return {
        easyserverCliHelp: {
          pluginId: "fixture.plugin",
          providerId: "fixture",
          displayName: "Fixture Provider",
          features: [
            {
              id: "marketplace",
              displayName: "Marketplace",
              commands: [
                {
                  name: "search",
                  description: "Search provider offers",
                  operation: "read",
                  help: {},
                },
              ],
            },
          ],
        },
      };
    },
  });

  assert.deepEqual(imported, ["@fixture/provider/easyserver-help"]);
  assert.equal(contribution?.providerId, "fixture");
  assert.equal(contribution?.features[0].commands[0].name, "search");
});

test("local and URL plugin sources do not get their executable entrypoint guessed for help", async () => {
  assert.equal(providerHelpSpecifier("@scope/provider"), "@scope/provider/easyserver-help");
  assert.equal(providerHelpSpecifier("provider-package"), "provider-package/easyserver-help");
  assert.equal(providerHelpSpecifier("./provider.mjs"), undefined);
  assert.equal(providerHelpSpecifier("C:\\plugins\\provider.mjs"), undefined);
  assert.equal(providerHelpSpecifier("file:///tmp/provider.mjs"), undefined);
  assert.equal(providerHelpSpecifier("data:text/javascript,export default {}"), undefined);

  const stateFile = join(testDirectory, "local-state.json");
  await new JsonStateStore(stateFile).write({
    version: 1,
    plugins: [{ source: "./provider.mjs", enabled: true }],
  });
  let importCalls = 0;
  const contribution = await loadProviderCliHelp("fixture", {
    stateFile,
    async importer() {
      importCalls += 1;
      throw new Error("normal plugin entrypoint must never be imported");
    },
  });
  assert.equal(contribution, undefined);
  assert.equal(importCalls, 0);
});
