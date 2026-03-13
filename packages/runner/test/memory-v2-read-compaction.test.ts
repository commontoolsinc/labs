import { assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";

const DOCUMENT_ADDRESS = {
  id: "bench:read-compaction" as const,
  type: "application/json" as const,
  path: [] as string[],
};

const createRuntime = async (label: string) => {
  const signer = await Identity.fromPassphrase(label);
  const storage = StorageManager.emulate({
    as: signer,
    memoryVersion: "v2",
  });
  const runtime = new Runtime({
    storageManager: storage,
    memoryVersion: "v2",
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
  assertEquals(reads.confirmed[0].path, ["value", "value"]);

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
    reads.confirmed.map((read) => read.path.join("/")).toSorted(),
    [
      "value/value",
      "value/value/section0/field0",
    ].toSorted(),
  );

  await runtime.dispose();
  await storage.close();
});
