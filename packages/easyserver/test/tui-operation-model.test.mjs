import assert from "node:assert/strict";
import test from "node:test";
import { HostOperationRunner } from "../dist/host-operation.js";
import {
  appendProviderTranscript,
  isTuiOperationPresentation,
  presentHostTrustRequest,
  presentMutationConfirmation,
  presentOperationError,
  presentProviderExecution,
  presentSessionState,
  presentWorkingOperation,
  withProviderTranscript,
} from "../dist/tui-operation-model.js";

test("working operations expose only caller-declared cancellation and no retry semantics", () => {
  const presentation = presentWorkingOperation({
    title: "Refresh instances",
    activity: "loading",
    cancellable: true,
  });

  assert.equal(presentation.phase, "working");
  assert.equal(presentation.activity, "loading");
  assert.deepEqual(
    presentation.actions.map((action) => action.kind),
    ["cancel"],
  );
  assert.equal(presentation.actions.some((action) => action.kind === "retry"), false);
});

test("outcome-unknown is a distinct warning and never offers blind mutation retry", () => {
  const presentation = presentOperationError({
    title: "Rent GPU",
    operation: "mutation",
    error: {
      kind: "easyserver-error",
      code: "outcome-unknown",
      message: "rent outcome is unknown after possible dispatch",
    },
  });

  assert.equal(presentation.phase, "outcome-unknown");
  assert.equal(presentation.tone, "warning");
  assert.deepEqual(
    presentation.actions.map((action) => action.kind),
    ["observe", "refresh", "dismiss"],
  );
  assert.doesNotMatch(
    presentation.actions.map((action) => action.kind).join(","),
    /retry/,
  );
  assert.match(presentation.detail, /do not repeat/i);
});

test("confirmed mutation success remains success when reconciliation fails", () => {
  const presentation = presentProviderExecution("Rent GPU", {
    operation: "mutation",
    mutationOutcome: "succeeded",
    handoff: {
      status: "failed",
      failure: "inventory-refresh-failed",
      affectedProviderExternalIds: ["remote-1"],
      canonicalInstances: [],
      unresolvedProviderExternalIds: ["remote-1"],
    },
  });

  assert.equal(presentation.phase, "reconciliation-failed");
  assert.equal(presentation.tone, "warning");
  assert.match(presentation.title, /succeeded/i);
  assert.match(presentation.detail, /inventory refresh/i);
  assert.deepEqual(
    presentation.actions.map((action) => action.kind),
    ["observe", "refresh", "dismiss"],
  );
  assert.doesNotMatch(
    presentation.actions.map((action) => action.kind).join(","),
    /retry/,
  );
});

test("mutation Retry requires host-certified pre-dispatch failure", async () => {
  const error = {
    kind: "easyserver-error",
    code: "provider-unavailable",
    message: "provider unavailable",
  };

  const read = presentOperationError({
    title: "Refresh instances",
    operation: "read",
    error,
  });
  assert.equal(read.actions[0].kind, "retry");

  const mutation = presentOperationError({
    title: "Destroy instance",
    operation: "mutation",
    error,
  });
  assert.equal(mutation.actions.some((action) => action.kind === "retry"), false);

  const asserted = presentOperationError({
    title: "Destroy instance",
    operation: "mutation",
    error,
    retrySafety: "pre-dispatch",
  });
  assert.equal(asserted.actions.some((action) => action.kind === "retry"), false);

  let certifiedError;
  try {
    await new HostOperationRunner(100).run(
      "mutation",
      "fixture mutation",
      { signal: new AbortController().signal },
      async () => {
        throw error;
      },
    );
  } catch (caught) {
    certifiedError = caught;
  }

  assert.equal(certifiedError, error);
  const preDispatch = presentOperationError({
    title: "Destroy instance",
    operation: "mutation",
    error: certifiedError,
  });
  assert.equal(preDispatch.actions[0].kind, "retry");
});

test("post-dispatch definite provider failure remains definite but never receives generic Retry", async () => {
  const failure = {
    kind: "easyserver-error",
    code: "conflict",
    message: "provider rejected the mutation",
  };
  let caught;
  try {
    await new HostOperationRunner(100).run(
      "mutation",
      "fixture mutation",
      { signal: new AbortController().signal },
      async ({ markMutationDispatched }) => {
        markMutationDispatched();
        throw failure;
      },
    );
  } catch (error) {
    caught = error;
  }

  assert.equal(caught, failure);
  const presentation = presentOperationError({
    title: "Rent GPU",
    operation: "mutation",
    error: caught,
  });
  assert.equal(presentation.phase, "failed");
  assert.equal(presentation.actions.some((action) => action.kind === "retry"), false);
});

test("host-owned mutation confirmation preserves target, consequence and affected resources", () => {
  const presentation = presentMutationConfirmation(
    {
      summary: "Provider command vast/marketplace/rent (provider=vast)",
      risks: ["billable"],
      consequence: "may create or increase provider charges",
    },
    {
      target: "Vast.ai marketplace",
      affectedResources: ["Provider inventory"],
    },
  );

  assert.equal(presentation.phase, "awaiting-confirmation");
  assert.equal(presentation.interaction.kind, "mutation-confirmation");
  assert.equal(presentation.interaction.target, "Vast.ai marketplace");
  assert.deepEqual(presentation.interaction.affectedResources, ["Provider inventory"]);
  assert.match(presentation.interaction.consequence, /charges/);
});

test("only typed first-use SSH trust becomes a trust interaction", () => {
  const trust = presentHostTrustRequest({
    kind: "easyserver-error",
    code: "host-trust-required",
    message: "SSH host trust is required",
    host: "203.0.113.7",
    port: 22,
    keyType: "ssh-ed25519",
    fingerprint: "SHA256:fixture",
  });
  assert.equal(trust.interaction.kind, "host-trust");
  assert.equal(trust.interaction.fingerprint, "SHA256:fixture");

  const changedKey = presentOperationError({
    title: "Connect",
    operation: "read",
    error: {
      kind: "easyserver-error",
      code: "authentication",
      message: "SSH host key changed",
    },
  });
  assert.equal(changedKey.phase, "failed");
  assert.equal(changedKey.interaction, undefined);
});

test("failed daemon session stays local and does not expose generic mutation retry", () => {
  const presentation = presentSessionState({
    id: "session-1",
    instanceId: "instance-1",
    remoteHost: "127.0.0.1",
    remotePort: 8188,
    accessMethod: { id: "ssh", kind: "ssh", mode: "tunnel" },
    state: "failed",
    failure: {
      code: "plugin-failure",
      message: "Connection Session cleanup failed",
    },
  });

  assert.equal(presentation.phase, "failed");
  assert.match(presentation.title, /session-1/);
  assert.match(presentation.detail, /cleanup failed/);
  assert.deepEqual(
    presentation.actions.map((action) => action.kind),
    ["dismiss"],
  );
});

test("presentation seam is branded, immutable, terminal-safe and transcript-bounded", () => {
  const presentation = presentWorkingOperation({
    title: "Refresh\u001b[31m instances",
    detail: `${"x".repeat(5_000)}\u001b[31m`,
    activity: "loading",
  });

  assert.equal(isTuiOperationPresentation(presentation), true);
  assert.equal(Object.isFrozen(presentation), true);
  assert.doesNotMatch(presentation.title, /\u001b/);
  assert.doesNotMatch(presentation.detail, /\u001b/);
  assert.ok(presentation.detail.length <= 4_096);

  const withOutput = withProviderTranscript(
    presentation,
    {
      owner: "provider",
      stream: "error",
      text: `unsafe\u001b[31m${"y".repeat(100)}`,
    },
    32,
  );
  const outputText = withOutput.providerOutput.map((line) => line.text).join("");
  assert.equal(isTuiOperationPresentation(withOutput), true);
  assert.equal(Object.isFrozen(withOutput.providerOutput), true);
  assert.doesNotMatch(outputText, /\u001b/);
  assert.ok(outputText.length <= 32);

  const forged = {
    ...presentation,
    actions: [{ kind: "retry", label: "Retry" }],
  };
  assert.equal(isTuiOperationPresentation(forged), false);
});

test("provider transcript is escaped and bounded without becoming durable history", () => {
  let output = [];
  output = appendProviderTranscript(output, {
    owner: "provider",
    stream: "output",
    text: "safe\nforged\u001b[31m",
  }, 32);
  output = appendProviderTranscript(output, {
    owner: "provider",
    stream: "error",
    text: "second provider line",
  }, 32);

  const text = output.map((line) => line.text).join("|");
  const storedCharacters = output.reduce((sum, line) => sum + line.text.length, 0);
  assert.doesNotMatch(text, /\u001b/);
  assert.ok(storedCharacters <= 32);
  assert.equal(output.at(-1).stream, "error");
});
