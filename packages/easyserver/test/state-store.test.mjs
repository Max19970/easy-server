import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseSecretReference } from "@easyai101/easyserver-plugin-sdk";
import { JsonStateStore } from "../dist/state-store.js";

async function withTempDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "easyserver-state-"));

  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("missing state starts empty", async () => {
  await withTempDirectory(async (directory) => {
    const store = new JsonStateStore(join(directory, "state.json"));
    assert.deepEqual(await store.read(), { version: 1, plugins: [] });
  });
});

test("state survives a fresh store instance and atomic replacement", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "nested", "state.json");
    const first = new JsonStateStore(path);

    await first.write({
      version: 1,
      plugins: [{ source: "fixture:first", enabled: true }],
    });
    await first.write({
      version: 1,
      plugins: [{ source: "fixture:second", enabled: false }],
    });

    const second = new JsonStateStore(path);
    assert.deepEqual(await second.read(), {
      version: 1,
      plugins: [{ source: "fixture:second", enabled: false }],
    });
    assert.deepEqual(await readdir(join(directory, "nested")), [
      "state.json",
      "state.json.recovery",
    ]);
  });
});

test("concurrent state updates re-read under an exclusive lock instead of losing changes", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "state.json");
    const firstStore = new JsonStateStore(path);
    const secondStore = new JsonStateStore(path);
    await firstStore.write({ version: 1, plugins: [] });

    let firstEnteredResolve;
    const firstEntered = new Promise((resolve) => {
      firstEnteredResolve = resolve;
    });
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });

    const first = firstStore.update(async (state) => {
      firstEnteredResolve();
      await firstGate;
      return {
        ...state,
        plugins: [...state.plugins, { source: "fixture:first", enabled: true }],
      };
    });
    await firstEntered;
    const second = secondStore.update((state) => ({
      ...state,
      plugins: [...state.plugins, { source: "fixture:second", enabled: true }],
    }));
    releaseFirst();

    await Promise.all([first, second]);
    assert.deepEqual((await firstStore.read()).plugins, [
      { source: "fixture:first", enabled: true },
      { source: "fixture:second", enabled: true },
    ]);
    assert.deepEqual(await readdir(directory), ["state.json", "state.json.recovery"]);
  });
});

test("competing updates preserve unrelated plugin, credential, and instance changes", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "state.json");
    const first = new JsonStateStore(path);
    const second = new JsonStateStore(path);
    const third = new JsonStateStore(path);
    const initialSecretRef = parseSecretReference(
      "secret:550e8400-e29b-41d4-a716-446655440000",
    );
    const replacementSecretRef = parseSecretReference(
      "secret:9d832a32-2b45-4d1c-8f21-286b3a2aecee",
    );
    const instance = {
      id: "instance:f3e4bc3a-b59c-43db-b218-6bc77bb06acd",
      providerId: "fixture",
      providerExternalId: "remote-2",
    };

    await first.write({
      version: 1,
      plugins: [
        {
          source: "fixture:provider",
          enabled: true,
          credentials: [{ name: "apiToken", secretRef: initialSecretRef }],
        },
      ],
    });

    await Promise.all([
      first.update((state) => ({
        ...state,
        plugins: [...state.plugins, { source: "fixture:extra", enabled: false }],
      })),
      second.update((state) => ({
        ...state,
        plugins: state.plugins.map((plugin) =>
          plugin.source === "fixture:provider"
            ? {
                ...plugin,
                credentials: [{ name: "apiToken", secretRef: replacementSecretRef }],
              }
            : plugin,
        ),
      })),
      third.update((state) => ({
        ...state,
        instances: [...(state.instances ?? []), instance],
      })),
    ]);

    assert.deepEqual(await new JsonStateStore(path).read(), {
      version: 1,
      plugins: [
        {
          source: "fixture:provider",
          enabled: true,
          credentials: [{ name: "apiToken", secretRef: replacementSecretRef }],
        },
        { source: "fixture:extra", enabled: false },
      ],
      instances: [{ ...instance, management: "discovered" }],
    });
  });
});

test("compute instance bindings persist stable local and provider identities", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "state.json");
    const store = new JsonStateStore(path);
    const binding = {
      id: "instance:550e8400-e29b-41d4-a716-446655440000",
      providerId: "fixture",
      providerExternalId: "remote-17",
    };

    await store.write({ version: 1, plugins: [], instances: [binding] });

    assert.deepEqual(await store.read(), {
      version: 1,
      plugins: [],
      instances: [{ ...binding, management: "discovered" }],
    });

    await assert.rejects(
      store.write({
        version: 1,
        plugins: [],
        instances: [binding, { ...binding, id: "instance:9d832a32-2b45-4d1c-8f21-286b3a2aecee" }],
      }),
      /duplicate provider identity/,
    );
  });
});

test("managed provenance and pending acquisition identities persist without rotating canonical ids", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "state.json");
    const store = new JsonStateStore(path);
    const state = {
      version: 1,
      plugins: [],
      instances: [
        {
          id: "instance:550e8400-e29b-41d4-a716-446655440000",
          providerId: "fixture",
          providerExternalId: "managed-1",
          management: "managed",
        },
      ],
      pendingManagedResources: [
        { providerId: "fixture", providerExternalId: "pending-2" },
      ],
    };

    await store.write(state);
    assert.deepEqual(await store.read(), state);

    await assert.rejects(
      store.write({
        ...state,
        pendingManagedResources: [
          ...state.pendingManagedResources,
          state.pendingManagedResources[0],
        ],
      }),
      /duplicate provider identity/,
    );
    await assert.rejects(
      store.write({
        ...state,
        instances: [{ ...state.instances[0], management: "owned" }],
      }),
      /management must be discovered or managed/,
    );
  });
});

test("last-known instance observations persist only normalized privacy-safe fields", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "state.json");
    const store = new JsonStateStore(path);
    await store.write({
      version: 1,
      plugins: [],
      instances: [
        {
          id: "instance:550e8400-e29b-41d4-a716-446655440000",
          providerId: "fixture",
          providerExternalId: "remote-safe",
          observation: {
            state: "running",
            name: "Safe display name",
            observedAt: "2026-08-11T12:00:00.000Z",
            rawState: "provider-secret-ish-payload",
            availableActions: ["instance.destroy"],
            credential: "must-not-persist",
          },
        },
      ],
    });

    const expectedObservation = {
      state: "running",
      name: "Safe display name",
      observedAt: "2026-08-11T12:00:00.000Z",
    };
    assert.deepEqual((await store.read()).instances[0].observation, expectedObservation);
    const primary = await readFile(path, "utf8");
    const recovery = await readFile(`${path}.recovery`, "utf8");
    for (const serialized of [primary, recovery]) {
      assert.doesNotMatch(serialized, /provider-secret-ish-payload/);
      assert.doesNotMatch(serialized, /instance\.destroy/);
      assert.doesNotMatch(serialized, /must-not-persist/);
    }
  });
});

test("provider credential configuration persists only opaque secret references", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "state.json");
    const store = new JsonStateStore(path);
    const secretRef = parseSecretReference(
      "secret:550e8400-e29b-41d4-a716-446655440000",
    );

    await store.write({
      version: 1,
      plugins: [
        {
          source: "fixture:provider",
          enabled: true,
          credentials: [
            {
              name: "apiToken",
              secretRef,
              value: "fixture-secret-value",
            },
          ],
        },
      ],
    });

    assert.deepEqual(await store.read(), {
      version: 1,
      plugins: [
        {
          source: "fixture:provider",
          enabled: true,
          credentials: [{ name: "apiToken", secretRef }],
        },
      ],
    });

    const serialized = await readFile(path, "utf8");
    const recovery = await readFile(`${path}.recovery`, "utf8");
    assert.match(serialized, /secret:550e8400-e29b-41d4-a716-446655440000/);
    assert.match(recovery, /secret:550e8400-e29b-41d4-a716-446655440000/);
    assert.doesNotMatch(serialized, /fixture-secret-value/);
    assert.doesNotMatch(recovery, /fixture-secret-value/);
  });
});

test("rejects raw credential values where a secret reference is required", async () => {
  await withTempDirectory(async (directory) => {
    const store = new JsonStateStore(join(directory, "state.json"));

    await assert.rejects(
      store.write({
        version: 1,
        plugins: [
          {
            source: "fixture:provider",
            enabled: true,
            credentials: [{ name: "apiToken", secretRef: "fixture-secret-value" }],
          },
        ],
      }),
      /opaque secret reference/,
    );
  });
});

test("an interrupted temporary write cannot replace good state", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "state.json");
    const store = new JsonStateStore(path);
    const goodState = {
      version: 1,
      plugins: [{ source: "fixture:good", enabled: true }],
    };

    await store.write(goodState);
    await writeFile(`${path}.interrupted.tmp`, '{"version":1,"plugins":[', "utf8");

    assert.deepEqual(await new JsonStateStore(path).read(), goodState);
  });
});

test("a rejected write leaves the previous state intact", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "state.json");
    const store = new JsonStateStore(path);
    const goodState = {
      version: 1,
      plugins: [{ source: "fixture:good", enabled: true }],
    };

    await store.write(goodState);

    await assert.rejects(
      store.write({
        version: 1,
        plugins: [{ source: "fixture:bad", enabled: "yes" }],
      }),
      /enabled must be a boolean/,
    );

    assert.deepEqual(await store.read(), goodState);
  });
});

test("replacement failure leaves the previous state intact", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "state.json");
    const goodState = {
      version: 1,
      plugins: [{ source: "fixture:good", enabled: true }],
    };
    await new JsonStateStore(path).write(goodState);

    const store = new JsonStateStore(path, async () => {
      throw new Error("fixture replacement failure");
    });
    await assert.rejects(
      store.write({
        version: 1,
        plugins: [{ source: "fixture:new", enabled: false }],
      }),
      /fixture replacement failure/,
    );

    assert.deepEqual(await new JsonStateStore(path).read(), goodState);
    assert.deepEqual(await readdir(directory), ["state.json", "state.json.recovery"]);
  });
});

test("corrupt primary state is reported instead of silently reset", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "state.json");
    await writeFile(path, "{not json", "utf8");

    await assert.rejects(
      new JsonStateStore(path).read(),
      /Invalid EasyServer state file/,
    );
  });
});

test("corrupt primary recovers the last-known-good state in a fresh process", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "state.json");
    const secretRef = parseSecretReference(
      "secret:550e8400-e29b-41d4-a716-446655440000",
    );
    const expected = {
      version: 1,
      plugins: [
        {
          source: "fixture:provider",
          enabled: true,
          credentials: [{ name: "apiToken", secretRef }],
        },
      ],
      instances: [
        {
          id: "instance:f3e4bc3a-b59c-43db-b218-6bc77bb06acd",
          providerId: "fixture",
          providerExternalId: "remote-recovery",
        },
      ],
    };
    await new JsonStateStore(path).write(expected);
    await writeFile(path, "{corrupt primary", "utf8");

    const moduleUrl = new URL("../dist/state-store.js", import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { JsonStateStore } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(await new JsonStateStore(${JSON.stringify(path)}).read()));`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      ...expected,
      instances: expected.instances.map((binding) => ({
        ...binding,
        management: "discovered",
      })),
    });
  });
});

test("missing primary after a committed write recovers instead of starting empty", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "state.json");
    const expected = {
      version: 1,
      plugins: [{ source: "fixture:configured", enabled: true }],
    };
    await new JsonStateStore(path).write(expected);
    await rm(path, { force: true });

    assert.deepEqual(await new JsonStateStore(path).read(), expected);
  });
});

test("invalid primary and invalid recovery fail closed", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "state.json");
    await new JsonStateStore(path).write({
      version: 1,
      plugins: [{ source: "fixture:configured", enabled: true }],
    });
    await writeFile(path, "{corrupt primary", "utf8");
    await writeFile(`${path}.recovery`, "{corrupt recovery", "utf8");

    await assert.rejects(
      new JsonStateStore(path).read(),
      /Unable to recover EasyServer state/,
    );
  });
});

test("recovery advances only after primary commit and remains usable if recovery update fails", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "state.json");
    const firstState = {
      version: 1,
      plugins: [{ source: "fixture:first", enabled: true }],
    };
    const secondState = {
      version: 1,
      plugins: [{ source: "fixture:second", enabled: true }],
    };
    await new JsonStateStore(path).write(firstState);

    const failing = new JsonStateStore(path, async (from, to) => {
      if (to === `${path}.recovery`) {
        throw new Error("fixture recovery replacement failure");
      }
      const { rename } = await import("node:fs/promises");
      await rename(from, to);
    });
    await assert.rejects(
      failing.write(secondState),
      /fixture recovery replacement failure/,
    );

    assert.deepEqual(await new JsonStateStore(path).read(), secondState);
    assert.deepEqual(JSON.parse(await readFile(`${path}.recovery`, "utf8")), firstState);

    await writeFile(path, "{corrupt primary", "utf8");
    assert.deepEqual(await new JsonStateStore(path).read(), firstState);
  });
});
