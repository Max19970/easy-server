import test from "node:test";
import assert from "node:assert/strict";
import { ProviderFeatureOperations } from "../dist/provider-feature-operations.js";
import { ProviderFeatureHost } from "../dist/provider-feature-host.js";

const descriptor = {
  pluginId: "fixture.plugin",
  providerId: "fixture",
  featureId: "marketplace",
  displayName: "Marketplace",
};

test("provider feature operations expose structured commands and frontend-neutral interaction", async () => {
  const host = new ProviderFeatureHost();
  let releases = 0;
  let runs = 0;
  host.register(descriptor, () => ({
    ...descriptor,
    feature: {
      id: descriptor.featureId,
      displayName: descriptor.displayName,
      cli: {
        commands: [
          {
            name: "rent",
            description: "Rent one fixture resource",
            operation: "mutation",
            risks: ["billable"],
            help: {
              options: [
                {
                  name: "--size",
                  valueName: "name",
                  description: "Fixture size",
                  required: false,
                },
              ],
            },
            async run(args, context) {
              runs += 1;
              assert.deepEqual(args, ["--size", "small"]);
              context.markMutationDispatched();
              context.write("provider output\n");
              context.writeError("provider warning\n");
              return { refreshProviderInventory: false };
            },
          },
        ],
      },
    },
    async resolveCredential() {
      return undefined;
    },
    release() {
      releases += 1;
    },
  }));

  const inventory = {
    async recordAcquiredProviderResources() {},
    async refreshProvider() {
      assert.fail("inventory refresh was not requested");
    },
  };
  const operations = new ProviderFeatureOperations(host, inventory);

  assert.deepEqual(operations.listFeatures("fixture"), [descriptor]);
  const commands = operations.listCommands("fixture", "marketplace");
  assert.equal(releases, 1);
  assert.deepEqual(commands, [
    {
      name: "rent",
      description: "Rent one fixture resource",
      operation: "mutation",
      risks: ["billable"],
      help: {
        options: [
          {
            name: "--size",
            valueName: "name",
            description: "Fixture size",
            required: false,
          },
        ],
      },
    },
  ]);
  assert.equal("run" in commands[0], false);

  const prompts = [];
  const transcript = [];
  const result = await operations.execute({
    providerId: "fixture",
    featureId: "marketplace",
    commandName: "rent",
    args: ["--size", "small"],
    context: { signal: new AbortController().signal },
    interaction: {
      async confirm(prompt) {
        prompts.push(prompt);
        return true;
      },
      transcript(event) {
        transcript.push(event);
      },
    },
  });

  assert.equal(runs, 1);
  assert.equal(releases, 2);
  assert.deepEqual(prompts.map(({ risks, consequence }) => ({ risks, consequence })), [
    {
      risks: ["billable"],
      consequence: "may create or increase provider charges",
    },
  ]);
  assert.deepEqual(transcript, [
    { owner: "provider", stream: "output", text: "provider output\n" },
    { owner: "provider", stream: "error", text: "provider warning\n" },
  ]);
  assert.equal(result.operation, "mutation");
  assert.equal(result.mutationOutcome, "succeeded");
  assert.equal(result.handoff.status, "not-requested");
});
