import { assertEquals, assertFalse, assertRejects } from "@std/assert";
import { isLinkRef, linkRefFrom } from "@commonfabric/data-model/cell-rep";
import {
  FabricBytes,
  FabricEpochNsec,
  FabricRegExp,
} from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  materializeStableArrayCells,
  planStableArrayCells,
} from "../src/array-cell-identity.ts";
import {
  pushStableCellGraph,
  readStableCellGraphValue,
} from "../src/fabric-graph.ts";

Deno.test("stable graph writes keep child identity and hydrate linked values", async () => {
  const signer = await Identity.fromPassphrase("agent connector graph test");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space };
  let coldRuntime: Runtime | undefined;
  try {
    const parent = runtime.getCell(space, { graphTest: "parent" });
    const childIdsByPass: string[][] = [];
    for (const order of [["alpha", "beta"], ["beta", "alpha"]]) {
      const childIds: string[] = [];
      await pushStableCellGraph(connection, [{
        cell: parent,
        value: (materializeCell) => ({
          items: order.map((id) => {
            const child = materializeCell(
              { graphTest: "item", id },
              { id, label: id.toUpperCase() },
            );
            childIds.push(child.getAsNormalizedFullLink().id!);
            return child;
          }),
        }),
      }]);
      childIdsByPass.push(childIds);
    }

    assertEquals(childIdsByPass[0], [
      childIdsByPass[1][1],
      childIdsByPass[1][0],
    ]);

    coldRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    assertEquals(
      await readStableCellGraphValue(
        { ...connection, runtime: coldRuntime },
        coldRuntime.getCell(space, { graphTest: "parent" }),
      ),
      {
        items: [
          { id: "beta", label: "BETA" },
          { id: "alpha", label: "ALPHA" },
        ],
      },
    );
  } finally {
    await coldRuntime?.dispose();
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("stable graph writes preserve native Fabric values", async () => {
  const signer = await Identity.fromPassphrase(
    "agent connector native graph test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space };
  try {
    const root = runtime.getCell(space, { graphTest: "native-values" });
    await pushStableCellGraph(connection, [{
      cell: root,
      value: () => ({
        date: new Date("2026-07-27T12:34:56.000Z"),
        expression: /agent-data/gi,
        bytes: new Uint8Array([1, 2, 3]),
      }),
    }]);

    const stored = await readStableCellGraphValue(
      connection,
      root,
    ) as Record<string, unknown>;
    const date = stored.date as FabricEpochNsec;
    const expression = stored.expression as FabricRegExp;
    const bytes = stored.bytes as FabricBytes;
    assertEquals(date instanceof FabricEpochNsec, true);
    assertEquals(expression instanceof FabricRegExp, true);
    assertEquals(bytes instanceof FabricBytes, true);
    assertEquals(
      date.value,
      BigInt(new Date("2026-07-27T12:34:56.000Z").getTime()) * 1_000_000n,
    );
    assertEquals(expression.source, "agent-data");
    assertEquals(expression.flags, "gi");
    assertEquals(bytes.slice(), new Uint8Array([1, 2, 3]));
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("stable graph reads can preserve links in named fields", async () => {
  const signer = await Identity.fromPassphrase(
    "agent connector preserved graph link test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space };
  try {
    const child = runtime.getCell(space, { graphTest: "preserved-child" });
    const parent = runtime.getCell(space, { graphTest: "preserved-parent" });
    await pushStableCellGraph(connection, [{
      cell: child,
      value: () => ({ value: "child data" }),
    }, {
      cell: parent,
      value: () => ({ manifest: child }),
    }]);

    const preserved = await readStableCellGraphValue(
      connection,
      parent,
      new Map(),
      { preserveLinkFields: new Set(["manifest"]) },
    ) as Record<string, unknown>;

    assertEquals(isLinkRef(preserved.manifest), true);
    assertEquals(await readStableCellGraphValue(connection, parent), {
      manifest: { value: "child data" },
    });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("stable array planning preserves links to cell subpaths", async () => {
  const signer = await Identity.fromPassphrase(
    "agent connector graph subpath test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const connection = { runtime, spaceDid: space };
  try {
    const referenced = runtime.getCell(space, {
      graphTest: "subpath-reference",
    });
    const parent = runtime.getCell(space, { graphTest: "subpath-parent" });
    await pushStableCellGraph(connection, [{
      cell: referenced,
      value: () => ({ selected: "resolved" }),
    }]);
    const plan = await planStableArrayCells(
      { nested: referenced.key("selected") },
      { graphTest: "subpath-elements" },
    );
    await pushStableCellGraph(connection, [{
      cell: parent,
      value: (materializeCell) =>
        materializeStableArrayCells(
          plan,
          materializeCell,
        ) as Record<string, unknown>,
    }]);

    assertEquals(
      await readStableCellGraphValue(connection, parent),
      { nested: "resolved" },
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("stable graph field writes preserve document metadata", async () => {
  const signer = await Identity.fromPassphrase("agent connector field writes");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const space = signer.did();
  const cell = runtime.getCell(space, { graphTest: "field-writes" });
  const connection = { runtime, spaceDid: space };
  try {
    await pushStableCellGraph(connection, [{
      cell,
      value: () => ({ retained: "before", removed: "stale" }),
    }]);
    const link = cell.getAsNormalizedFullLink();
    const metadataTx = runtime.edit();
    metadataTx.writeOrThrow(
      {
        space: link.space,
        scope: link.scope,
        id: link.id,
        path: ["connectorMetadata"],
      },
      { preserved: true },
    );
    const metadataCommit = await metadataTx.commit();
    if (metadataCommit.error) throw metadataCommit.error;

    await pushStableCellGraph(connection, [{
      cell,
      value: () => ({ retained: "after" }),
    }]);

    const inspectionTx = runtime.edit();
    try {
      assertEquals(
        inspectionTx.readOrThrow({
          space: link.space,
          scope: link.scope,
          id: link.id,
          path: [],
        }),
        {
          connectorMetadata: { preserved: true },
          value: { retained: "after" },
        },
      );
    } finally {
      inspectionTx.abort();
    }
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

function fakeCell(id = "of:parent") {
  return {
    getAsNormalizedFullLink: () => ({
      space: "did:test:space",
      id,
      path: [],
    }),
  };
}

Deno.test("stable graph writes await one commit", async () => {
  const commitStarted = Promise.withResolvers<void>();
  const commitResult = Promise.withResolvers<{
    ok: Record<string, never>;
  }>();
  let commitCount = 0;
  const transaction = {
    readValueOrThrow: () => undefined,
    writeOrThrow: () => {},
    writeValueOrThrow: () => {},
    abort: () => ({ ok: {} }),
    commit: () => {
      commitCount++;
      commitStarted.resolve();
      return commitResult.promise;
    },
  };
  const connection = {
    runtime: { edit: () => transaction },
    spaceDid: "did:test:space",
  };
  let settled = false;
  const pending = pushStableCellGraph(
    // deno-lint-ignore no-explicit-any -- focused runtime fixture.
    connection as any,
    [{
      // deno-lint-ignore no-explicit-any -- focused cell fixture.
      cell: fakeCell() as any,
      value: () => ({ value: "ready" }),
    }],
  ).finally(() => settled = true);
  await commitStarted.promise;
  await Promise.resolve();
  assertFalse(settled);
  commitResult.resolve({ ok: {} });
  await pending;
  assertEquals(commitCount, 1);
});

Deno.test("stable graph writes surface a commit failure without retrying", async () => {
  const commitError = {
    name: "ConflictError",
    message: "commit rejected",
    transaction: { operations: [{ type: "write" }] },
  };
  let commitCount = 0;
  const connection = {
    runtime: {
      edit: () => ({
        readValueOrThrow: () => undefined,
        writeOrThrow: () => {},
        writeValueOrThrow: () => {},
        abort: () => ({ ok: {} }),
        commit: () => {
          commitCount++;
          return Promise.resolve({ error: commitError });
        },
      }),
    },
    spaceDid: "did:test:space",
  };
  const error = await assertRejects(
    () =>
      pushStableCellGraph(
        // deno-lint-ignore no-explicit-any -- focused runtime fixture.
        connection as any,
        [{
          // deno-lint-ignore no-explicit-any -- focused cell fixture.
          cell: fakeCell() as any,
          value: () => ({ value: "ready" }),
        }],
      ),
    Error,
    "commit rejected",
  );
  assertEquals(error.cause, commitError);
  assertEquals(commitCount, 1);
});

Deno.test("stable graph hydration bounds concurrent child syncs", async () => {
  const space = "did:test:space";
  const firstBatchStarted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let started = 0;
  let active = 0;
  let maximumActive = 0;
  const links = Array.from(
    { length: 51 },
    (_, index) => linkRefFrom({ id: `of:child-${index}`, path: [], space }),
  );
  const parent = {
    sync: () => Promise.resolve(),
    getRaw: () => links,
  };
  const runtime = {
    storageManager: { synced: () => Promise.resolve() },
    getCellFromLink: (link: { id: string }) => ({
      async sync() {
        started++;
        active++;
        maximumActive = Math.max(maximumActive, active);
        if (started === 50) firstBatchStarted.resolve();
        await release.promise;
        active--;
      },
      getRaw: () => ({ id: link.id }),
    }),
  };
  const pending = readStableCellGraphValue(
    // deno-lint-ignore no-explicit-any -- focused runtime fixture.
    { runtime, spaceDid: space } as any,
    // deno-lint-ignore no-explicit-any -- focused cell fixture.
    parent as any,
  );

  await firstBatchStarted.promise;
  await Promise.resolve();
  const observedMaximum = maximumActive;
  const observedStarted = started;
  release.resolve();
  const value = await pending;

  assertEquals(observedMaximum, 50);
  assertEquals(observedStarted, 50);
  assertEquals(maximumActive, 50);
  assertEquals(started, 51);
  assertEquals((value as unknown[]).length, 51);
});
