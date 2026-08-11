import assert from "node:assert/strict";
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
    assert.deepEqual(await readdir(join(directory, "nested")), ["state.json"]);
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
    assert.deepEqual(await readdir(directory), ["state.json"]);
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
      instances: [instance],
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
      instances: [binding],
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
    assert.match(serialized, /secret:550e8400-e29b-41d4-a716-446655440000/);
    assert.doesNotMatch(serialized, /fixture-secret-value/);
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
    assert.deepEqual(await readdir(directory), ["state.json"]);
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
