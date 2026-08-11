import assert from "node:assert/strict";
import test from "node:test";

import { requireMutationConfirmation } from "../dist/mutation-safety.js";

const context = { signal: new AbortController().signal };

test("safe mutations and explicit --yes bypass interactive confirmation", async () => {
  let confirmations = 0;
  const confirm = async () => {
    confirmations += 1;
    return true;
  };

  await requireMutationConfirmation("Safe mutation", [], context, {
    assumeYes: false,
    interactive: false,
    confirm,
  });
  await requireMutationConfirmation("Billable mutation", ["billable"], context, {
    assumeYes: true,
    interactive: false,
    confirm,
  });

  assert.equal(confirmations, 0);
});

test("interactive risky mutation exposes risk and consequence before dispatch", async () => {
  let prompt;
  await requireMutationConfirmation(
    "Destroy Compute Instance instance:fixture (provider=example)",
    ["billable", "destructive"],
    context,
    {
      assumeYes: false,
      interactive: true,
      async confirm(candidate) {
        prompt = candidate;
        return true;
      },
    },
  );

  assert.deepEqual(prompt, {
    summary: "Destroy Compute Instance instance:fixture (provider=example)",
    risks: ["billable", "destructive"],
    consequence:
      "may create or increase provider charges; may irreversibly delete or release a provider resource",
  });
});

test("interactive refusal is a definite pre-dispatch cancellation", async () => {
  await assert.rejects(
    requireMutationConfirmation("Risky mutation", ["destructive"], context, {
      assumeYes: false,
      interactive: true,
      async confirm() {
        return false;
      },
    }),
    (error) => error?.code === "cancelled" && /before dispatch/.test(error.message),
  );
});

test("non-interactive risky mutation requires explicit --yes without prompting", async () => {
  let confirmations = 0;
  await assert.rejects(
    requireMutationConfirmation("Risky mutation", ["billable"], context, {
      assumeYes: false,
      interactive: false,
      async confirm() {
        confirmations += 1;
        return true;
      },
    }),
    (error) => error?.code === "conflict" && /explicit --yes/.test(error.message),
  );
  assert.equal(confirmations, 0);
});
