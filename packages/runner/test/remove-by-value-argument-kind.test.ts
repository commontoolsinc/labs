import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";

// `removeByValue` and `addUnique` compare by link when handed a cell and by
// stored-value equality otherwise. An array element that is an object is its
// own entity, so the stored element is a link: a plain object read back out of
// `.get()` carries a link but is not a cell, and comparing it against the
// stored link never matches. The existing coverage in
// array-push-mergeable.test.ts uses string elements, which store inline, so the
// value form works there and this distinction does not show up.
//
// These cases pin the distinction for object elements, and pin that an element
// with no deterministic address is still removable through its positional cell.
// See docs/development/migrating-collection-writes.md.

const signer = await Identity.fromPassphrase("remove-by-value-argument-kind");
const space = signer.did();

interface Row {
  name: string;
}

const rowListSchema = {
  type: "array",
  items: {
    type: "object",
    properties: { name: { type: "string" } },
  },
  // deno-lint-ignore no-explicit-any
} as any;

function withRuntime(
  cause: string,
  run: (rt: Runtime) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const storage = EmulatedStorageManager.emulate({ as: signer });
    const rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    try {
      const tx = rt.edit();
      const seed = rt.getCell<Row[]>(space, cause, rowListSchema, tx);
      // Appended, so each entity id comes from the append counter rather than
      // from a key: the shape a collection holds before a keyed migration.
      seed.push({ name: "alice" });
      seed.push({ name: "bob" });
      await tx.commit();
      await run(rt);
    } finally {
      await rt.dispose();
      await storage.close();
    }
  };
}

describe("removeByValue argument kind, for object elements", () => {
  it(
    "a plain object read back from get() removes nothing",
    withRuntime("value-form", async (rt) => {
      const tx = rt.edit();
      const cell = rt.getCell<Row[]>(space, "value-form", rowListSchema, tx);
      const row = cell.get().find((r) => r.name === "alice");
      cell.removeByValue(row!);
      await tx.commit();

      const after = rt.getCell<Row[]>(space, "value-form", rowListSchema).get();
      expect(after.map((r) => r.name)).toEqual(["alice", "bob"]);
    }),
  );

  it(
    "the element's positional cell removes it",
    withRuntime("cell-form", async (rt) => {
      const tx = rt.edit();
      const cell = rt.getCell<Row[]>(space, "cell-form", rowListSchema, tx);
      const index = cell.get().findIndex((r) => r.name === "alice");
      cell.removeByValue(cell.key(index));
      await tx.commit();

      const after = rt.getCell<Row[]>(space, "cell-form", rowListSchema).get();
      expect(after.map((r) => r.name)).toEqual(["bob"]);
    }),
  );

  it(
    "a plain object read back from get() is added again by addUnique",
    withRuntime("add-unique", async (rt) => {
      const tx = rt.edit();
      const cell = rt.getCell<Row[]>(space, "add-unique", rowListSchema, tx);
      const row = cell.get().find((r) => r.name === "alice");
      cell.addUnique(row!);
      await tx.commit();

      const after = rt.getCell<Row[]>(space, "add-unique", rowListSchema).get();
      expect(after.map((r) => r.name)).toEqual(["alice", "bob", "alice"]);
    }),
  );

  it(
    "the element's own cell is deduped by addUnique",
    withRuntime("add-unique-cell", async (rt) => {
      const tx = rt.edit();
      const cell = rt.getCell<Row[]>(
        space,
        "add-unique-cell",
        rowListSchema,
        tx,
      );
      cell.addUnique(cell.key(0));
      await tx.commit();

      const after = rt.getCell<Row[]>(space, "add-unique-cell", rowListSchema)
        .get();
      expect(after.map((r) => r.name)).toEqual(["alice", "bob"]);
    }),
  );
});
