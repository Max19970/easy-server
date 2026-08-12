import test from "node:test";
import assert from "node:assert/strict";
import { normalizedError } from "@easyai101/easyserver-plugin-sdk";
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
      presentation: { kind: "cli-fallback" },
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

test("provider interactive sessions prepare args through generic screens and reuse command safety and handoff", async () => {
  const host = new ProviderFeatureHost();
  const nebulaDescriptor = {
    pluginId: "fixture.nebula",
    providerId: "nebula",
    featureId: "allocation",
    displayName: "Allocation",
  };
  let releases = 0;
  let opens = 0;
  let dispatches = 0;
  let runs = 0;
  host.register(nebulaDescriptor, () => ({
    ...nebulaDescriptor,
    feature: {
      id: "allocation",
      displayName: "Allocation",
      cli: {
        commands: [
          {
            name: "provision",
            description: "Provision a Nebula allocation",
            operation: "mutation",
            risks: ["billable"],
            help: {
              options: [
                {
                  name: "--region",
                  valueName: "region",
                  description: "Nebula region",
                  required: true,
                },
              ],
            },
            async run(args, context) {
              runs += 1;
              assert.deepEqual(args, ["--region", "eu-north"]);
              assert.equal(await context.resolveCredential("api-token"), "resolved-token");
              context.markMutationDispatched();
              return {
                refreshProviderInventory: true,
                affectedProviderExternalIds: ["nebula-42"],
              };
            },
          },
        ],
      },
      interactive: {
        flows: [
          {
            id: "provision-wizard",
            commandName: "provision",
            async open(context) {
              opens += 1;
              assert.equal("markMutationDispatched" in context, false);
              assert.equal(await context.resolveCredential("api-token"), "resolved-token");
              return {
                initialScreen: {
                  kind: "form",
                  id: "configure",
                  title: "Configure Nebula allocation",
                  fields: [
                    {
                      kind: "single-choice",
                      id: "region",
                      label: "Region",
                      required: true,
                      choices: [{ id: "eu-north", label: "EU North" }],
                      value: "eu-north",
                    },
                  ],
                  actions: [
                    { id: "review", label: "Review", kind: "primary" },
                  ],
                },
                async dispatch(event, context) {
                  dispatches += 1;
                  assert.equal("markMutationDispatched" in context, false);
                  if (event.kind === "field-change") {
                    return {
                      kind: "screen",
                      screen: {
                        kind: "review",
                        id: "review",
                        title: "Review allocation",
                        items: [{ label: "Region", value: "EU North" }],
                        actions: [
                          { id: "submit", label: "Provision", kind: "submit" },
                        ],
                      },
                    };
                  }
                  return {
                    kind: "submit",
                    args: ["--region", "eu-north"],
                  };
                },
              };
            },
          },
        ],
      },
    },
    async resolveCredential(name) {
      assert.equal(name, "api-token");
      return "resolved-token";
    },
    release() {
      releases += 1;
    },
  }));

  const recorded = [];
  const inventory = {
    async recordAcquiredProviderResources(providerId, providerExternalIds) {
      recorded.push({ providerId, providerExternalIds });
    },
    async refreshProvider(providerId) {
      assert.equal(providerId, "nebula");
      return [
        {
          id: "instance:nebula-42",
          providerId: "nebula",
          providerExternalId: "nebula-42",
          management: "managed",
          freshness: "fresh",
          state: "running",
          rawState: "READY",
          availableActions: [],
        },
      ];
    },
  };
  const operations = new ProviderFeatureOperations(host, inventory);

  assert.deepEqual(operations.listCommands("nebula", "allocation"), [
    {
      name: "provision",
      description: "Provision a Nebula allocation",
      operation: "mutation",
      risks: ["billable"],
      presentation: {
        kind: "interactive-flow",
        flowId: "provision-wizard",
      },
      help: {
        options: [
          {
            name: "--region",
            valueName: "region",
            description: "Nebula region",
            required: true,
          },
        ],
      },
    },
  ]);
  assert.equal(releases, 1);
  assert.deepEqual(operations.listInteractiveFlows("nebula", "allocation"), [
    {
      id: "provision-wizard",
      commandName: "provision",
      command: {
        name: "provision",
        description: "Provision a Nebula allocation",
        operation: "mutation",
        risks: ["billable"],
        presentation: {
          kind: "interactive-flow",
          flowId: "provision-wizard",
        },
        help: {
          options: [
            {
              name: "--region",
              valueName: "region",
              description: "Nebula region",
              required: true,
            },
          ],
        },
      },
    },
  ]);
  assert.equal(releases, 2);

  const context = { signal: new AbortController().signal };
  const session = await operations.openInteractiveFlow({
    providerId: "nebula",
    featureId: "allocation",
    flowId: "provision-wizard",
    context,
  });
  assert.equal(opens, 1);
  assert.equal(releases, 2, "the feature admission stays leased while the flow is open");
  assert.equal(session.screen.kind, "form");
  assert.equal(session.descriptor.command.name, "provision");

  const review = await session.dispatch(
    { kind: "field-change", fieldId: "region", value: "eu-north" },
    context,
  );
  assert.equal(review.kind, "screen");
  assert.equal(review.screen.kind, "review");
  assert.equal(session.screen.kind, "review");
  assert.equal(runs, 0);

  const prompts = [];
  const executed = await session.dispatch(
    { kind: "action", actionId: "submit" },
    context,
    {
      async confirm(prompt) {
        prompts.push(prompt);
        return true;
      },
    },
  );
  assert.equal(executed.kind, "executed");
  assert.equal(runs, 1);
  assert.equal(dispatches, 2);
  assert.equal(releases, 3);
  assert.deepEqual(prompts.map((prompt) => prompt.risks), [["billable"]]);
  assert.deepEqual(recorded, [
    { providerId: "nebula", providerExternalIds: ["nebula-42"] },
  ]);
  assert.equal(executed.execution.mutationOutcome, "succeeded");
  assert.deepEqual(executed.execution.handoff, {
    status: "complete",
    affectedProviderExternalIds: ["nebula-42"],
    canonicalInstances: [
      { providerExternalId: "nebula-42", instanceId: "instance:nebula-42" },
    ],
    unresolvedProviderExternalIds: [],
  });

  await assert.rejects(
    session.dispatch({ kind: "action", actionId: "submit" }, context),
    /interactive flow session is closed/,
  );
});

test("provider interactive submit inherits outcome-unknown reconciliation and cannot be repeated", async () => {
  const host = new ProviderFeatureHost();
  let releases = 0;
  let runs = 0;
  let refreshes = 0;
  host.register(descriptor, () => ({
    ...descriptor,
    feature: {
      id: descriptor.featureId,
      displayName: descriptor.displayName,
      cli: {
        commands: [
          {
            name: "rent",
            description: "Rent fixture",
            operation: "mutation",
            async run(_args, context) {
              runs += 1;
              context.markMutationDispatched();
              throw normalizedError(
                "outcome-unknown",
                "fixture mutation outcome is unknown",
              );
            },
          },
        ],
      },
      interactive: {
        flows: [
          {
            id: "rent-wizard",
            commandName: "rent",
            async open() {
              return {
                initialScreen: {
                  kind: "review",
                  id: "review",
                  title: "Review",
                  items: [],
                  actions: [
                    { id: "submit", label: "Rent", kind: "submit" },
                  ],
                },
                async dispatch() {
                  return { kind: "submit", args: [] };
                },
              };
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
  const operations = new ProviderFeatureOperations(host, {
    async recordAcquiredProviderResources() {},
    async refreshProvider() {
      refreshes += 1;
      return [];
    },
  });
  const context = { signal: new AbortController().signal };
  const session = await operations.openInteractiveFlow({
    providerId: "fixture",
    featureId: "marketplace",
    flowId: "rent-wizard",
    context,
  });

  await assert.rejects(
    session.dispatch({ kind: "action", actionId: "submit" }, context),
    (error) => error?.code === "outcome-unknown",
  );
  assert.equal(runs, 1);
  assert.equal(refreshes, 1);
  assert.equal(releases, 1);
  await assert.rejects(
    session.dispatch({ kind: "action", actionId: "submit" }, context),
    /interactive flow session is closed/,
  );
  assert.equal(runs, 1);
});

test("provider interactive flow cancellation releases admission without dispatching the linked command", async () => {
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
            description: "Rent fixture",
            operation: "mutation",
            risks: ["billable"],
            async run() {
              runs += 1;
            },
          },
        ],
      },
      interactive: {
        flows: [
          {
            id: "rent-wizard",
            commandName: "rent",
            async open() {
              return {
                initialScreen: {
                  kind: "review",
                  id: "review",
                  title: "Review",
                  items: [],
                  actions: [],
                },
                async dispatch() {
                  return { kind: "submit", args: [] };
                },
              };
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
  const operations = new ProviderFeatureOperations(host, {
    async recordAcquiredProviderResources() {},
    async refreshProvider() {
      return [];
    },
  });
  const context = { signal: new AbortController().signal };
  const session = await operations.openInteractiveFlow({
    providerId: "fixture",
    featureId: "marketplace",
    flowId: "rent-wizard",
    context,
  });

  session.close();
  session.close();
  assert.equal(releases, 1);
  assert.equal(runs, 0);
  await assert.rejects(
    session.dispatch({ kind: "action", actionId: "submit" }, context),
    /interactive flow session is closed/,
  );
});
