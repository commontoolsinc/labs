import { assert, assertEquals } from "@std/assert";
import { dataURIFromValue } from "../src/data-uri-codec.ts";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { excludeReadFromConflict } from "../src/storage/reactivity-log.ts";
import { txToReactivityLog } from "../src/scheduler.ts";

const DOCUMENT_ADDRESS = {
  id: "bench:read-compaction" as const,
  type: "application/json" as const,
  scope: "space" as const,
  path: [] as string[],
};

const createRuntime = async (label: string) => {
  const signer = await Identity.fromPassphrase(label);
  const storage = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    storageManager: storage,
    apiUrl: new URL(import.meta.url),
  });
  return { signer, storage, runtime };
};

Deno.test("memory v2 compacts descendant confirmed reads under a recursive ancestor", async () => {
  const { signer, storage, runtime } = await createRuntime(
    "memory-v2-read-compaction-recursive",
  );
  const space = signer.did();

  const seed = runtime.edit();
  seed.writeValueOrThrow(
    { ...DOCUMENT_ADDRESS, space },
    {
      section0: { field0: "value0", field1: "value1" },
      section1: { field0: "value2" },
    },
  );
  assertEquals((await seed.commit()).ok, {});

  const tx = runtime.edit();
  tx.readValueOrThrow({ ...DOCUMENT_ADDRESS, space, path: [] });
  tx.readValueOrThrow({ ...DOCUMENT_ADDRESS, space, path: ["section0"] });
  tx.readValueOrThrow({
    ...DOCUMENT_ADDRESS,
    space,
    path: ["section0", "field0"],
  });

  const replica = storage.open(space).replica as unknown as {
    buildReads(source: unknown, localSeq: number): {
      confirmed: Array<{ path: string[]; seq: number }>;
      pending: Array<{ path: string[]; localSeq: number }>;
    };
  };
  const reads = replica.buildReads(tx.tx, 1);

  assertEquals(reads.pending, []);
  assertEquals(reads.confirmed.length, 1);
  assertEquals(reads.confirmed[0].path, ["value"]);

  await runtime.dispose();
  await storage.close();
});

Deno.test("memory v2 keeps descendant reads when the ancestor is non-recursive", async () => {
  const { signer, storage, runtime } = await createRuntime(
    "memory-v2-read-compaction-non-recursive",
  );
  const space = signer.did();

  const seed = runtime.edit();
  seed.writeValueOrThrow(
    { ...DOCUMENT_ADDRESS, space },
    {
      section0: { field0: "value0", field1: "value1" },
      section1: { field0: "value2" },
    },
  );
  assertEquals((await seed.commit()).ok, {});

  const tx = runtime.edit();
  tx.readValueOrThrow(
    { ...DOCUMENT_ADDRESS, space, path: [] },
    { nonRecursive: true },
  );
  tx.readValueOrThrow({
    ...DOCUMENT_ADDRESS,
    space,
    path: ["section0", "field0"],
  });

  const replica = storage.open(space).replica as unknown as {
    buildReads(source: unknown, localSeq: number): {
      confirmed: Array<{ path: string[]; seq: number }>;
      pending: Array<{ path: string[]; localSeq: number }>;
    };
  };
  const reads = replica.buildReads(tx.tx, 1);

  assertEquals(reads.pending, []);
  assertEquals(
    reads.confirmed.map((read) => read.path).toSorted((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    ),
    [
      ["value"],
      ["value", "section0", "field0"],
    ].toSorted((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    ),
  );

  await runtime.dispose();
  await storage.close();
});

Deno.test("memory v2 excludes inline data URI reads from tracked commit dependencies", async () => {
  const { signer, storage, runtime } = await createRuntime(
    "memory-v2-read-compaction-inline-data",
  );
  const space = signer.did();
  const dataUri = dataURIFromValue({ inline: true });

  const seed = runtime.edit();
  seed.writeValueOrThrow(
    { ...DOCUMENT_ADDRESS, space },
    { live: { nested: "value" } },
  );
  assertEquals((await seed.commit()).ok, {});

  const tx = runtime.edit();
  tx.readValueOrThrow({ ...DOCUMENT_ADDRESS, space, path: ["live"] });
  tx.readValueOrThrow({
    ...DOCUMENT_ADDRESS,
    space,
    scope: "space",
    id: dataUri,
    path: [],
  });

  const replica = storage.open(space).replica as unknown as {
    buildReads(source: unknown, localSeq: number): {
      confirmed: Array<{ id: string; path: string[]; seq: number }>;
      pending: Array<{ id: string; path: string[]; localSeq: number }>;
    };
  };
  const directReads = [...(tx.tx.getReadActivities?.() ?? [])];
  const reads = replica.buildReads(tx.tx, 1);

  assertEquals(
    directReads.map((read) => ({ id: read.id, path: read.path })),
    [{ id: DOCUMENT_ADDRESS.id, path: ["value", "live"] }],
  );
  assertEquals(reads.pending, []);
  assertEquals(
    reads.confirmed.map((read) => ({ id: read.id, path: read.path })),
    [{ id: DOCUMENT_ADDRESS.id, path: ["value", "live"] }],
  );

  await runtime.dispose();
  await storage.close();
});

Deno.test("memory v2 excludeReadFromConflict drops ONLY marked nonRecursive (reference) reads — by-value reads are kept", async () => {
  const { signer, storage, runtime } = await createRuntime(
    "memory-v2-read-compaction-exclude-conflict",
  );
  const space = signer.did();

  const seed = runtime.edit();
  seed.writeValueOrThrow(
    { ...DOCUMENT_ADDRESS, space },
    { refShape: { a: 1, b: 2 }, scalar: 5, other: 7 },
  );
  assertEquals((await seed.commit()).ok, {});

  const tx = runtime.edit();
  // (1) marked + nonRecursive: an asCell reference-resolution shape read -> EXCLUDED.
  tx.readValueOrThrow(
    { ...DOCUMENT_ADDRESS, space, path: ["refShape"] },
    { meta: excludeReadFromConflict, nonRecursive: true },
  );
  // (2) marked + RECURSIVE: the nonRecursive guard keeps it (defense for value reads).
  tx.readValueOrThrow(
    { ...DOCUMENT_ADDRESS, space, path: ["other"] },
    { meta: excludeReadFromConflict },
  );
  // (3) UNMARKED + nonRecursive: a by-value scalar argument read -> KEPT.
  //     This is the closed hole: the over-broad scoping used to drop this.
  tx.readValueOrThrow(
    { ...DOCUMENT_ADDRESS, space, path: ["scalar"] },
    { nonRecursive: true },
  );

  const replica = storage.open(space).replica as unknown as {
    buildReads(source: unknown, localSeq: number): {
      confirmed: Array<{ path: string[]; seq: number }>;
      pending: Array<{ path: string[]; localSeq: number }>;
    };
  };
  const reads = replica.buildReads(tx.tx, 1);
  const paths = reads.confirmed.map((read) => read.path.join("."));

  assert(
    !paths.includes("value.refShape"),
    `marked nonRecursive reference read should be excluded; got ${paths}`,
  );
  assert(
    paths.includes("value.other"),
    `marked RECURSIVE read must be kept (value dependency); got ${paths}`,
  );
  assert(
    paths.includes("value.scalar"),
    `unmarked nonRecursive by-value read must be kept; got ${paths}`,
  );

  await runtime.dispose();
  await storage.close();
});

Deno.test("memory v2 excludeReadFromConflict reads STAY in the reactivity log (a repointed link still re-triggers the holder)", async () => {
  // excludeReadFromConflict removes a read from the COMMIT-CONFLICT set only; it
  // must NOT remove it from the reactivity log. The asCell reference-resolution
  // read (the link read) therefore remains a reactive dependency, so if the link
  // is repointed the holder is reader-dirtied and re-runs — it just no longer
  // collides with disjoint writers under the referent. This pins the reactivity
  // half (the conflict half is covered by the test above).
  const { signer, storage, runtime } = await createRuntime(
    "memory-v2-read-compaction-exclude-reactivity",
  );
  const space = signer.did();

  const seed = runtime.edit();
  seed.writeValueOrThrow(
    { ...DOCUMENT_ADDRESS, space },
    { refShape: { a: 1, b: 2 } },
  );
  assertEquals((await seed.commit()).ok, {});

  const tx = runtime.edit();
  // The link read: a marked, nonRecursive reference-resolution shape read.
  tx.readValueOrThrow(
    { ...DOCUMENT_ADDRESS, space, path: ["refShape"] },
    { meta: excludeReadFromConflict, nonRecursive: true },
  );

  const replica = storage.open(space).replica as unknown as {
    buildReads(source: unknown, localSeq: number): {
      confirmed: Array<{ path: string[]; seq: number }>;
      pending: Array<{ path: string[]; localSeq: number }>;
    };
  };

  // Conflict set DROPS the link read (no spurious collision with disjoint writers).
  const conflictPaths = replica.buildReads(tx.tx, 1).confirmed.map((read) =>
    read.path.join(".")
  );
  assert(
    !conflictPaths.some((p) => p.endsWith("refShape")),
    `reference read must be excluded from the conflict set; got ${conflictPaths}`,
  );

  // Reactivity log KEEPS the link read (as a shallow/nonRecursive read) — this is
  // what makes a repointed link re-trigger the holder.
  const log = txToReactivityLog(tx);
  const reactivePaths = [...log.reads, ...log.shallowReads].map((address) =>
    address.path.join(".")
  );
  assert(
    reactivePaths.some((p) => p.endsWith("refShape")),
    `reference read must stay a reactive dependency; got reads=${
      log.reads.map((a) => a.path.join("."))
    } shallowReads=${log.shallowReads.map((a) => a.path.join("."))}`,
  );

  await runtime.dispose();
  await storage.close();
});
