import assert from "node:assert/strict";
import test from "node:test";

import { normalizedError } from "@easyai101/easyserver-plugin-sdk";
import { ProviderCommandRunner } from "../dist/provider-command-runner.js";

function computeInstance(providerExternalId, instanceId) {
  return {
    id: instanceId,
    providerId: "fixture",
    providerExternalId,
    state: "running",
    rawState: "READY",
    availableActions: [],
  };
}

function request(command, inventory) {
  return {
    providerId: "fixture",
    featureId: "marketplace",
    command,
    args: [],
    admission: {
      async resolveCredential() {
        return undefined;
      },
    },
    inventory,
    context: { signal: new AbortController().signal },
    write() {},
    writeError() {},
  };
}

test("confirmed mutation reconciles affected provider identity to canonical instance id", async () => {
  let mutationCalls = 0;
  let refreshCalls = 0;
  const command = {
    name: "rent",
    description: "Rent",
    operation: "mutation",
    async run(_args, context) {
      mutationCalls += 1;
      context.markMutationDispatched();
      return {
        refreshProviderInventory: true,
        affectedProviderExternalIds: ["777"],
      };
    },
  };
  const inventory = {
    async refreshProvider() {
      refreshCalls += 1;
      return [computeInstance("777", "instance:11111111-1111-4111-8111-111111111111")];
    },
  };

  const result = await new ProviderCommandRunner().run(request(command, inventory));

  assert.equal(mutationCalls, 1);
  assert.equal(refreshCalls, 1);
  assert.equal(result.mutationOutcome, "succeeded");
  assert.deepEqual(result.handoff, {
    status: "complete",
    affectedProviderExternalIds: ["777"],
    canonicalInstances: [
      {
        providerExternalId: "777",
        instanceId: "instance:11111111-1111-4111-8111-111111111111",
      },
    ],
    unresolvedProviderExternalIds: [],
  });
});

test("confirmed mutation stays successful when immediate reconciliation fails", async () => {
  let mutationCalls = 0;
  let refreshCalls = 0;
  const command = {
    name: "create",
    description: "Create",
    operation: "mutation",
    async run(_args, context) {
      mutationCalls += 1;
      context.markMutationDispatched();
      return {
        refreshProviderInventory: true,
        affectedProviderExternalIds: ["501"],
      };
    },
  };
  const inventory = {
    async refreshProvider() {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        throw normalizedError("provider-unavailable", "fixture refresh outage");
      }
      return [computeInstance("501", "instance:22222222-2222-4222-8222-222222222222")];
    },
  };

  const result = await new ProviderCommandRunner().run(request(command, inventory));

  assert.equal(mutationCalls, 1);
  assert.deepEqual(result.handoff, {
    status: "failed",
    failure: "inventory-refresh-failed",
    affectedProviderExternalIds: ["501"],
    canonicalInstances: [],
    unresolvedProviderExternalIds: ["501"],
  });

  const laterObservation = await inventory.refreshProvider("fixture", {
    signal: new AbortController().signal,
  });
  assert.equal(laterObservation[0].id, "instance:22222222-2222-4222-8222-222222222222");
  assert.equal(mutationCalls, 1, "later observation must not redispatch the billable mutation");
  assert.equal(refreshCalls, 2);
});

test("multiple affected resources produce deterministic partial handoff", async () => {
  const command = {
    name: "create-many",
    description: "Create many",
    operation: "mutation",
    async run() {
      return {
        affectedProviderExternalIds: ["a", "b", "c"],
      };
    },
  };
  const inventory = {
    async refreshProvider() {
      return [
        computeInstance("a", "instance:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        computeInstance("c", "instance:cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
      ];
    },
  };

  const result = await new ProviderCommandRunner().run(request(command, inventory));

  assert.deepEqual(result.handoff, {
    status: "partial",
    affectedProviderExternalIds: ["a", "b", "c"],
    canonicalInstances: [
      {
        providerExternalId: "a",
        instanceId: "instance:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
      {
        providerExternalId: "c",
        instanceId: "instance:cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      },
    ],
    unresolvedProviderExternalIds: ["b"],
  });
});

test("outcome-unknown remains distinct from confirmed mutation success", async () => {
  let refreshCalls = 0;
  const command = {
    name: "rent",
    description: "Rent",
    operation: "mutation",
    async run(_args, context) {
      context.markMutationDispatched();
      throw normalizedError("outcome-unknown", "fixture mutation is uncertain");
    },
  };
  const inventory = {
    async refreshProvider() {
      refreshCalls += 1;
      return [];
    },
  };

  await assert.rejects(
    new ProviderCommandRunner().run(request(command, inventory)),
    (error) => error?.code === "outcome-unknown",
  );
  assert.equal(refreshCalls, 1);
});

test("malformed post-success handoff cannot turn a confirmed mutation into a retryable failure", async () => {
  let mutationCalls = 0;
  const command = {
    name: "rent",
    description: "Rent",
    operation: "mutation",
    async run() {
      mutationCalls += 1;
      return {
        refreshProviderInventory: "yes",
        affectedProviderExternalIds: ["777"],
      };
    },
  };
  const inventory = {
    async refreshProvider() {
      assert.fail("invalid provider result must not start reconciliation");
    },
  };

  const result = await new ProviderCommandRunner().run(request(command, inventory));

  assert.equal(mutationCalls, 1);
  assert.equal(result.mutationOutcome, "succeeded");
  assert.deepEqual(result.handoff, {
    status: "failed",
    failure: "invalid-provider-result",
    affectedProviderExternalIds: [],
    canonicalInstances: [],
    unresolvedProviderExternalIds: [],
  });
});
