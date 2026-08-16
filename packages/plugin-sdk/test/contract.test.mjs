import assert from "node:assert/strict";
import test from "node:test";

import {
  hostTrustRequiredError,
  isHostTrustRequiredError,
  isNormalizedError,
  isProviderCliUsageError,
  isSecretReference,
  isSshAccessMethod,
  normalizedError,
  parseAccessMethods,
  parsePluginManifest,
  parseProviderCliCommandResult,
  parseProviderCliHelpModule,
  parseProviderInteractiveScreen,
  parseProviderInteractiveTransition,
  parseProviderInstanceList,
  parseProviderPlugin,
  parseSecretReference,
  providerCliUsageError,
  PluginContractError,
} from "../dist/index.js";

const validManifest = {
  id: "vastai",
  displayName: "Vast.ai",
  version: "0.2.0",
  compatibility: {
    easyserver: ">=0.2.0 <1.0.0",
    pluginSdk: ">=0.2.0 <1.0.0",
  },
  provider: {
    id: "vastai",
    displayName: "Vast.ai",
    capabilities: ["instance.stop", "instance.destroy"],
  },
};

function provider(overrides = {}) {
  return {
    providerId: "vastai",
    async listInstances() {
      return [];
    },
    async getInstance() {
      return undefined;
    },
    async performPowerAction() {},
    async destroy() {},
    ...overrides,
  };
}

test("accepts a valid provider plugin", () => {
  const plugin = parseProviderPlugin({
    manifest: validManifest,
    provider: provider(),
  });

  assert.equal(plugin.manifest.provider.id, "vastai");
  assert.deepEqual(plugin.manifest.provider.capabilities, [
    "instance.stop",
    "instance.destroy",
  ]);
});

test("rejects malformed manifests at the plugin boundary", () => {
  assert.throws(
    () =>
      parsePluginManifest({
        ...validManifest,
        version: "banana",
      }),
    PluginContractError,
  );

  assert.throws(
    () =>
      parsePluginManifest({
        ...validManifest,
        provider: {
          ...validManifest.provider,
          capabilities: ["instance.stop", "instance.stop"],
        },
      }),
    PluginContractError,
  );

  assert.throws(
    () =>
      parseProviderPlugin({
        manifest: validManifest,
        provider: provider({ providerId: "intelion" }),
      }),
    PluginContractError,
  );
});

test("validates optional plugin credential descriptors", () => {
  assert.deepEqual(
    parsePluginManifest({
      ...validManifest,
      credentials: [
        {
          name: "api-key",
          required: true,
          description: "Provider API key",
        },
        { name: "profile", required: false },
      ],
    }).credentials,
    [
      {
        name: "api-key",
        required: true,
        description: "Provider API key",
      },
      { name: "profile", required: false },
    ],
  );
  assert.equal(parsePluginManifest(validManifest).credentials, undefined);
  assert.throws(
    () =>
      parsePluginManifest({
        ...validManifest,
        credentials: [
          { name: "api-key", required: true },
          { name: "api-key", required: false },
        ],
      }),
    /duplicate name/,
  );
  assert.throws(
    () =>
      parsePluginManifest({
        ...validManifest,
        credentials: [{ name: "API key", required: true }],
      }),
    /must start with a lowercase letter/,
  );
  assert.throws(
    () =>
      parsePluginManifest({
        ...validManifest,
        credentials: [{ name: "api-key", required: "yes" }],
      }),
    /required must be a boolean/,
  );
});

test("declared lifecycle capabilities require matching adapter methods", () => {
  const withoutPowerAction = provider();
  delete withoutPowerAction.performPowerAction;
  assert.throws(
    () =>
      parseProviderPlugin({
        manifest: validManifest,
        provider: withoutPowerAction,
      }),
    /performPowerAction/,
  );

  const withoutDestroy = provider();
  delete withoutDestroy.destroy;
  assert.throws(
    () =>
      parseProviderPlugin({
        manifest: validManifest,
        provider: withoutDestroy,
      }),
    /destroy/,
  );
});

test("validates provider feature identities without interpreting feature payloads", () => {
  const feature = {
    id: "marketplace",
    displayName: "Marketplace",
    fixturePayload: { providerOwned: true },
  };
  const plugin = parseProviderPlugin({
    manifest: validManifest,
    provider: provider(),
    features: [feature],
  });

  assert.equal(plugin.features?.[0], feature);

  assert.throws(
    () =>
      parseProviderPlugin({
        manifest: validManifest,
        provider: provider(),
        features: [feature, feature],
      }),
    /duplicate id/,
  );
});

test("validates provider-owned interactive flows without introducing provider domain fields", async () => {
  const run = async () => ({
    refreshProviderInventory: true,
    affectedProviderExternalIds: ["nebula-42"],
  });
  const open = async () => ({
    initialScreen: {
      kind: "form",
      id: "configure",
      title: "Configure Nebula allocation",
      fields: [
        {
          kind: "text",
          id: "region",
          label: "Region",
          required: true,
          value: "eu-north",
        },
      ],
      actions: [{ id: "continue", label: "Continue", kind: "primary" }],
    },
    async dispatch() {
      return { kind: "submit", args: ["--region", "eu-north"] };
    },
  });
  const feature = {
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
          run,
        },
      ],
    },
    interactive: {
      flows: [
        {
          id: "provision-wizard",
          commandName: "provision",
          open,
        },
      ],
    },
  };

  const plugin = parseProviderPlugin({
    manifest: {
      ...validManifest,
      id: "nebula",
      displayName: "Nebula Compute",
      provider: {
        id: "nebula",
        displayName: "Nebula Compute",
        capabilities: [],
      },
    },
    provider: {
      providerId: "nebula",
      async listInstances() {
        return [];
      },
      async getInstance() {
        return undefined;
      },
    },
    features: [feature],
  });

  assert.equal(plugin.features?.[0], feature);
  assert.equal(plugin.features?.[0].interactive?.flows[0].open, open);

  assert.throws(
    () =>
      parseProviderPlugin({
        manifest: {
          ...validManifest,
          id: "nebula",
          displayName: "Nebula Compute",
          provider: {
            id: "nebula",
            displayName: "Nebula Compute",
            capabilities: [],
          },
        },
        provider: {
          providerId: "nebula",
          async listInstances() {
            return [];
          },
          async getInstance() {
            return undefined;
          },
        },
        features: [
          {
            ...feature,
            interactive: {
              flows: [
                {
                  id: "orphan-wizard",
                  commandName: "missing-command",
                  open,
                },
              ],
            },
          },
        ],
      }),
    /must reference a declared CLI command/,
  );
});

test("validates the generic interactive screen and submission vocabulary", () => {
  const form = parseProviderInteractiveScreen({
    kind: "form",
    id: "configure",
    title: "Configure resource",
    description: "Provider-owned fields",
    fields: [
      {
        kind: "text",
        id: "label",
        label: "Label",
        required: false,
        repeatable: true,
        value: ["alpha", "beta"],
      },
      {
        kind: "integer",
        id: "count",
        label: "Count",
        required: true,
        value: 2,
      },
      {
        kind: "decimal",
        id: "budget",
        label: "Budget",
        required: false,
        value: 1.25,
        validation: { state: "valid" },
      },
      {
        kind: "boolean",
        id: "verified-only",
        label: "Verified only",
        required: false,
        value: true,
      },
      {
        kind: "single-choice",
        id: "zone",
        label: "Zone",
        required: true,
        loading: false,
        choices: [
          { id: "zone-a", label: "Zone A" },
          { id: "zone-b", label: "Zone B", disabled: true },
        ],
        value: "zone-a",
      },
      {
        kind: "multiple-choice",
        id: "tags",
        label: "Tags",
        required: false,
        choices: [
          { id: "fast", label: "Fast" },
          { id: "cheap", label: "Cheap" },
        ],
        value: ["fast"],
      },
    ],
    actions: [
      { id: "refresh", label: "Refresh", kind: "refresh" },
      { id: "review", label: "Review", kind: "primary" },
    ],
  });
  assert.equal(form.kind, "form");
  assert.equal(form.fields.length, 6);

  const table = parseProviderInteractiveScreen({
    kind: "table",
    id: "results",
    title: "Results",
    columns: [
      { id: "name", label: "Name" },
      { id: "price", label: "Price" },
    ],
    rows: [
      { id: "row-1", cells: { name: "One", price: 1.2 } },
      { id: "row-2", cells: { name: "Two", price: 2.4 }, disabled: true },
    ],
    selection: "single",
    selectedRowIds: ["row-1"],
    actions: [{ id: "continue", label: "Continue", kind: "primary" }],
  });
  assert.equal(table.kind, "table");
  assert.deepEqual(table.selectedRowIds, ["row-1"]);

  const review = parseProviderInteractiveScreen({
    kind: "review",
    id: "review",
    title: "Review",
    items: [
      { label: "Target", value: "row-1" },
      { label: "Cost", value: "$1.20/hour" },
    ],
    actions: [
      { id: "back", label: "Back", kind: "back" },
      { id: "submit", label: "Create", kind: "submit" },
    ],
  });
  assert.equal(review.kind, "review");

  assert.deepEqual(
    parseProviderInteractiveTransition({
      kind: "submit",
      args: ["--zone", "zone-a", "--count", "2"],
    }),
    {
      kind: "submit",
      args: ["--zone", "zone-a", "--count", "2"],
    },
  );

  assert.throws(
    () =>
      parseProviderInteractiveScreen({
        kind: "form",
        id: "broken",
        title: "Broken",
        fields: [
          { kind: "text", id: "same", label: "One", required: false },
          { kind: "text", id: "same", label: "Two", required: false },
        ],
        actions: [],
      }),
    /duplicate field id/,
  );
});

test("validates provider CLI contributions without interpreting command arguments", () => {
  const run = async () => {};
  const feature = {
    id: "marketplace",
    displayName: "Marketplace",
    cli: {
      commands: [
        {
          name: "search",
          description: "Search offers",
          operation: "read",
          help: {
            options: [
              {
                name: "--gpu",
                valueName: "gpu-name",
                description: "GPU model",
                required: false,
              },
            ],
            examples: ["--gpu 'RTX 4090'"],
          },
          run,
        },
        { name: "rent", description: "Rent one offer", operation: "mutation", run },
      ],
    },
  };
  const plugin = parseProviderPlugin({
    manifest: validManifest,
    provider: provider(),
    features: [feature],
  });

  assert.equal(plugin.features?.[0], feature);
  assert.equal(plugin.features?.[0].cli?.commands[0].run, run);
  assert.deepEqual(plugin.features?.[0].cli?.commands[0].help, {
    options: [
      {
        name: "--gpu",
        valueName: "gpu-name",
        description: "GPU model",
        required: false,
      },
    ],
    examples: ["--gpu 'RTX 4090'"],
  });

  assert.throws(
    () =>
      parseProviderPlugin({
        manifest: validManifest,
        provider: provider(),
        features: [
          {
            ...feature,
            cli: {
              commands: [
                { name: "search", description: "One", operation: "read", run },
                { name: "search", description: "Two", operation: "read", run },
              ],
            },
          },
        ],
      }),
    /duplicate name/,
  );

  assert.throws(
    () =>
      parseProviderPlugin({
        manifest: validManifest,
        provider: provider(),
        features: [
          {
            ...feature,
            cli: {
              commands: [{ name: "search", description: "Search offers", run }],
            },
          },
        ],
      }),
    /operation must be read or mutation/,
  );

  assert.throws(
    () =>
      parseProviderPlugin({
        manifest: validManifest,
        provider: provider(),
        features: [
          {
            ...feature,
            cli: {
              commands: [
                {
                  name: "search",
                  description: "Search offers",
                  operation: "read",
                  help: {
                    options: [
                      {
                        name: "gpu",
                        description: "GPU model",
                        required: false,
                      },
                    ],
                  },
                  run,
                },
              ],
            },
          },
        ],
      }),
    /must be a long option/,
  );

  assert.throws(
    () =>
      parseProviderPlugin({
        manifest: validManifest,
        provider: provider(),
        features: [
          {
            ...feature,
            cli: {
              commands: [
                {
                  name: "search",
                  description: "Search offers",
                  operation: "read",
                  help: {
                    options: [
                      {
                        name: "--gpu",
                        description: "GPU model",
                        required: false,
                      },
                      {
                        name: "--gpu",
                        description: "Duplicate GPU option",
                        required: false,
                      },
                    ],
                  },
                  run,
                },
              ],
            },
          },
        ],
      }),
    /contains duplicate name/,
  );
});

test("validates provider mutation risk metadata", () => {
  const run = async () => {};
  const plugin = parseProviderPlugin({
    manifest: validManifest,
    provider: provider(),
    features: [
      {
        id: "marketplace",
        displayName: "Marketplace",
        cli: {
          commands: [
            {
              name: "rent",
              description: "Rent one offer",
              operation: "mutation",
              risks: ["billable", "destructive"],
              run,
            },
          ],
        },
      },
    ],
  });
  assert.deepEqual(plugin.features?.[0].cli?.commands[0].risks, [
    "billable",
    "destructive",
  ]);

  for (const [operation, risks, pattern] of [
    ["read", ["billable"], /only for mutation commands/],
    ["mutation", ["billable", "billable"], /must not contain duplicates/],
    ["mutation", ["expensive"], /must be billable or destructive/],
  ]) {
    assert.throws(
      () =>
        parseProviderPlugin({
          manifest: validManifest,
          provider: provider(),
          features: [
            {
              id: "marketplace",
              displayName: "Marketplace",
              cli: {
                commands: [
                  {
                    name: "rent",
                    description: "Rent one offer",
                    operation,
                    risks,
                    run,
                  },
                ],
              },
            },
          ],
        }),
      pattern,
    );
  }
});

test("validates dedicated provider CLI help-only contributions without executable command functions", () => {
  const contribution = parseProviderCliHelpModule({
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
              name: "rent",
              description: "Rent one provider resource",
              operation: "mutation",
              risks: ["billable"],
              help: {
                arguments: [
                  {
                    name: "offer-id",
                    description: "Provider offer ID",
                    required: true,
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  });

  assert.equal(contribution.providerId, "fixture");
  assert.equal(contribution.features[0].commands[0].name, "rent");
  assert.equal("run" in contribution.features[0].commands[0], false);

  assert.throws(
    () =>
      parseProviderCliHelpModule({
        easyserverCliHelp: {
          pluginId: "fixture.plugin",
          providerId: "fixture",
          features: [
            {
              id: "marketplace",
              displayName: "Marketplace",
              commands: [
                {
                  name: "read",
                  description: "Read",
                  operation: "read",
                  risks: ["billable"],
                },
              ],
            },
          ],
        },
      }),
    /only for mutation commands/,
  );

  assert.throws(
    () =>
      parseProviderCliHelpModule({
        easyserverCliHelp: {
          pluginId: "fixture.plugin",
          providerId: "fixture",
          features: [
            {
              id: "marketplace",
              displayName: "Marketplace",
              commands: [
                {
                  name: "read",
                  description: "Read",
                  operation: "read",
                  async run() {},
                },
              ],
            },
          ],
        },
      }),
    /run is not allowed/,
  );
});

test("provider CLI usage errors are structural across SDK copies", () => {
  const error = providerCliUsageError("Missing provider argument");
  assert.equal(error instanceof Error, true);
  assert.equal(error.kind, "easyserver-provider-cli-usage-error");
  assert.equal(error.message, "Missing provider argument");
  assert.equal(isProviderCliUsageError(error), true);
  assert.equal(
    isProviderCliUsageError({
      kind: "easyserver-provider-cli-usage-error",
      message: "Third-party SDK copy",
    }),
    true,
  );
  assert.equal(isProviderCliUsageError(new Error("ordinary failure")), false);
});

test("validates provider CLI affected identities for host reconciliation", () => {
  assert.deepEqual(
    parseProviderCliCommandResult({
      refreshProviderInventory: true,
      affectedProviderExternalIds: ["777", "778"],
    }),
    {
      refreshProviderInventory: true,
      affectedProviderExternalIds: ["777", "778"],
    },
  );
  assert.equal(parseProviderCliCommandResult(undefined), undefined);
  assert.throws(
    () =>
      parseProviderCliCommandResult({
        affectedProviderExternalIds: ["777", "777"],
      }),
    /must not contain duplicates/,
  );
  assert.throws(
    () =>
      parseProviderCliCommandResult({ affectedProviderExternalIds: [""] }),
    /must be a non-empty string/,
  );
});

test("keeps access method discovery secret-free and validates adapter ownership", () => {
  const secretRef = "secret:550e8400-e29b-41d4-a716-446655440000";
  assert.deepEqual(
    parseAccessMethods([
      {
        id: "proxy",
        kind: "vastai:proxy",
        mode: "tcp-forward",
        credentialSources: [
          { kind: "secret-ref", secretRef },
          { kind: "provider-deferred", id: "temporary-ssh" },
        ],
      },
    ]),
    [
      {
        id: "proxy",
        kind: "vastai:proxy",
        mode: "tcp-forward",
        credentialSources: [
          { kind: "secret-ref", secretRef },
          { kind: "provider-deferred", id: "temporary-ssh" },
        ],
      },
    ],
  );

  assert.deepEqual(
    parseAccessMethods([
      {
        id: "password-ssh",
        kind: "ssh",
        mode: "tcp-forward",
        credentialSources: [
          { kind: "provider-deferred", id: "ssh-password" },
        ],
        ssh: {
          host: "ssh.example.test",
          port: 22,
          username: "root",
          passwordCredentialId: "ssh-password",
        },
      },
    ]),
    [
      {
        id: "password-ssh",
        kind: "ssh",
        mode: "tcp-forward",
        credentialSources: [
          { kind: "provider-deferred", id: "ssh-password" },
        ],
        ssh: {
          host: "ssh.example.test",
          port: 22,
          username: "root",
          passwordCredentialId: "ssh-password",
        },
      },
    ],
  );

  assert.throws(
    () =>
      parseAccessMethods([
        {
          id: "bad-password-source",
          kind: "ssh",
          mode: "tcp-forward",
          ssh: {
            host: "ssh.example.test",
            port: 22,
            username: "root",
            passwordCredentialId: "undeclared-password",
          },
        },
      ]),
    /passwordCredentialId must reference a declared provider-deferred credential source/,
  );

  assert.throws(
    () =>
      parseAccessMethods([
        {
          id: "bad",
          kind: "ssh",
          mode: "tcp-forward",
          password: "raw-secret",
        },
      ]),
    /password is not allowed/,
  );

  const accessAdapter = {
    kind: "vastai:proxy",
    async openTcpForward() {
      throw new Error("not used");
    },
  };
  const plugin = parseProviderPlugin({
    manifest: validManifest,
    provider: provider(),
    accessAdapters: [accessAdapter],
  });
  assert.equal(plugin.accessAdapters?.[0], accessAdapter);

  assert.throws(
    () =>
      parseProviderPlugin({
        manifest: validManifest,
        provider: provider(),
        accessAdapters: [{ ...accessAdapter, kind: "proxy" }],
      }),
    /namespaced to provider vastai/,
  );
});

test("validates SSH access descriptors and typed host-trust errors", () => {
  const secretRef = "secret:550e8400-e29b-41d4-a716-446655440000";
  const [method] = parseAccessMethods([
    {
      id: "direct-ssh",
      kind: "ssh",
      mode: "tcp-forward",
      ssh: {
        host: "gpu.example.net",
        port: 2222,
        username: "ubuntu",
        privateKeySecretRef: secretRef,
      },
    },
  ]);

  assert.equal(isSshAccessMethod(method), true);
  assert.equal(method.ssh.host, "gpu.example.net");
  assert.equal(method.ssh.port, 2222);
  assert.equal(method.ssh.privateKeySecretRef, secretRef);

  assert.throws(
    () =>
      parseAccessMethods([
        {
          id: "interactive-ssh",
          kind: "ssh",
          mode: "interactive",
          ssh: { host: "gpu.example.net", port: 22, username: "ubuntu" },
        },
      ]),
    /must use tcp-forward mode/,
  );
  assert.throws(
    () =>
      parseAccessMethods([
        {
          id: "missing-ssh",
          kind: "ssh",
          mode: "tcp-forward",
        },
      ]),
    /\.ssh must be an object/,
  );
  assert.throws(
    () =>
      parseAccessMethods([
        {
          id: "option-like-host",
          kind: "ssh",
          mode: "tcp-forward",
          ssh: {
            host: "-oProxyCommand=attacker",
            port: 22,
            username: "ubuntu",
          },
        },
      ]),
    /must not begin with a hyphen/,
  );
  assert.throws(
    () =>
      parseAccessMethods([
        {
          id: "raw-password",
          kind: "ssh",
          mode: "tcp-forward",
          ssh: {
            host: "gpu.example.net",
            port: 22,
            username: "ubuntu",
            password: "raw-secret",
          },
        },
      ]),
    /password is not allowed/,
  );

  const trust = hostTrustRequiredError(
    "gpu.example.net",
    22,
    "ssh-ed25519",
    "SHA256:fixture",
  );
  assert.equal(isHostTrustRequiredError(trust), true);
  assert.equal(trust.message.includes(trust.fingerprint), false);
  assert.equal(isHostTrustRequiredError(normalizedError("authentication", "no")), false);
});

test("validates opaque secret references", () => {
  const ref = parseSecretReference("secret:550e8400-e29b-41d4-a716-446655440000");

  assert.equal(isSecretReference(ref), true);
  assert.equal(isSecretReference("not-a-secret-ref"), false);
  assert.throws(() => parseSecretReference("secret:banana"), PluginContractError);
});

test("validates normalized provider inventory and per-instance available actions", () => {
  const instances = parseProviderInstanceList(
    [
      {
        providerExternalId: "contract-1",
        name: "Training",
        state: "running",
        rawState: "RUNNING",
        availableActions: ["instance.stop"],
      },
      {
        providerExternalId: "contract-2",
        state: "unknown",
        rawState: 17,
        availableActions: [],
      },
    ],
    ["instance.stop"],
  );

  assert.equal(instances[1].state, "unknown");
  assert.equal(instances[1].rawState, 17);

  assert.throws(
    () =>
      parseProviderInstanceList(
        [
          {
            providerExternalId: "contract-1",
            state: "stopped",
            rawState: "stopped",
            availableActions: ["instance.start"],
          },
        ],
        ["instance.stop"],
      ),
    /not declared by the provider/,
  );

  assert.throws(
    () =>
      parseProviderInstanceList(
        [
          {
            providerExternalId: "duplicate",
            state: "running",
            rawState: "running",
            availableActions: [],
          },
          {
            providerExternalId: "duplicate",
            state: "stopped",
            rawState: "stopped",
            availableActions: [],
          },
        ],
        [],
      ),
    /duplicate providerExternalId/,
  );
});

test("a host-owned abort signal reaches a blocking plugin invocation", async () => {
  const controller = new AbortController();

  const blockingInvocation = ({ signal }) =>
    new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
    });

  const result = blockingInvocation({ signal: controller.signal });
  controller.abort();

  assert.equal(await result, "cancelled");
});

test("distinguishes definite cancellation from unknown mutation outcome", () => {
  const cancelled = normalizedError("cancelled", "cancelled before dispatch");
  const unknown = normalizedError(
    "outcome-unknown",
    "remote mutation may have been dispatched",
  );

  assert.equal(cancelled.code, "cancelled");
  assert.equal(unknown.code, "outcome-unknown");
  assert.equal(isNormalizedError(cancelled), true);
  assert.equal(isNormalizedError(unknown), true);
  assert.equal(isNormalizedError({ code: "cancelled" }), false);
});
