import assert from "node:assert/strict";
import test from "node:test";

import { createDiagnosticsReport } from "../dist/diagnostics.js";

test("diagnostics expose troubleshooting state without secret or resource identifiers", () => {
  const secretValue = "fixture-super-secret";
  const secretRef = "secret:550e8400-e29b-41d4-a716-446655440000";
  const providerExternalId = "account-resource-4815162342";
  const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----";
  const daemonToken = "daemon-auth-token-private";
  const localPluginPath = "C:\\Users\\person\\private\\provider-plugin.mjs";

  const report = createDiagnosticsReport({
    easyserverVersion: "0.1.7",
    nodeVersion: "v24.18.1",
    platform: "win32",
    arch: "x64",
    stateStatus: "ok",
    state: {
      version: 1,
      plugins: [
        {
          source: localPluginPath,
          enabled: true,
          credentials: [{ name: "api-key", secretRef }],
        },
      ],
      instances: [
        {
          id: "instance:550e8400-e29b-41d4-a716-446655440001",
          providerId: "private-provider",
          providerExternalId,
        },
      ],
    },
    pluginStatuses: [
      {
        source: localPluginPath,
        state: "failed",
        error: `load failed ${secretValue} ${secretRef} ${privateKey} ${daemonToken}`,
      },
    ],
    daemonStatus: { status: "running", sessionCount: 2 },
    sshAvailable: true,
    sshKeyscanAvailable: false,
  });

  assert.deepEqual(report, {
    schemaVersion: 1,
    easyserver: { version: "0.1.7" },
    runtime: { node: "v24.18.1", platform: "win32", arch: "x64" },
    state: {
      status: "ok",
      configuredPlugins: 1,
      credentialBindings: 1,
      instanceBindings: 1,
    },
    plugins: [
      {
        identity: "configured-plugin-1",
        state: "failed",
        failure: "load-failed",
      },
    ],
    daemon: { status: "running", sessionCount: 2 },
    access: { ssh: "available", sshKeyscan: "unavailable" },
  });

  const serialized = JSON.stringify(report);
  for (const sensitive of [
    secretValue,
    secretRef,
    providerExternalId,
    privateKey,
    daemonToken,
    localPluginPath,
    "instance:550e8400-e29b-41d4-a716-446655440001",
  ]) {
    assert.equal(serialized.includes(sensitive), false, `diagnostics leaked ${sensitive}`);
  }
});

test("diagnostics reduce raw plugin failures to safe categories", () => {
  const base = {
    stateStatus: "empty",
    state: { version: 1, plugins: [] },
    daemonStatus: { status: "stopped" },
    sshAvailable: false,
    sshKeyscanAvailable: false,
  };

  const report = createDiagnosticsReport({
    ...base,
    pluginStatuses: [
      {
        source: "@example/incompatible-provider",
        state: "failed",
        error: "Plugin private details requires EasyServer ^0.2.0",
      },
      {
        source: "@example/hung-provider",
        state: "failed",
        error: "Plugin load timed out after 10000 ms: private-source",
      },
    ],
  });

  assert.deepEqual(report.plugins, [
    {
      identity: "@example/incompatible-provider",
      state: "failed",
      failure: "incompatible",
    },
    {
      identity: "@example/hung-provider",
      state: "failed",
      failure: "timeout",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(report), /private details|private-source/);
});
