import assert from "node:assert/strict";
import test from "node:test";
import { HostOperationRunner } from "../dist/host-operation.js";

function context(signal = new AbortController().signal) {
  return { signal };
}

test("cancelled mutation is rejected before provider dispatch", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;

  await assert.rejects(
    new HostOperationRunner(25).run(
      "mutation",
      "fixture mutation",
      context(controller.signal),
      async () => {
        calls += 1;
      },
    ),
    (error) => error?.code === "cancelled",
  );
  assert.equal(calls, 0);
});

test("host deadline bounds a non-cooperative read", async () => {
  await assert.rejects(
    new HostOperationRunner(20).run(
      "read",
      "fixture read",
      context(),
      async () => new Promise(() => {}),
    ),
    (error) => error?.code === "timeout",
  );
});

test("host deadline after mutation dispatch reports outcome unknown without retry", async () => {
  let calls = 0;

  await assert.rejects(
    new HostOperationRunner(20).run(
      "mutation",
      "fixture mutation",
      context(),
      async () => {
        calls += 1;
        return new Promise(() => {});
      },
    ),
    (error) => error?.code === "outcome-unknown",
  );
  assert.equal(calls, 1);
});

test("caller cancellation after mutation dispatch reports outcome unknown", async () => {
  const controller = new AbortController();
  let dispatched;
  const didDispatch = new Promise((resolve) => {
    dispatched = resolve;
  });
  const run = new HostOperationRunner(500).run(
    "mutation",
    "fixture mutation",
    context(controller.signal),
    async ({ signal }) => {
      dispatched();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    },
  );

  await didDispatch;
  controller.abort();

  await assert.rejects(run, (error) => error?.code === "outcome-unknown");
});
