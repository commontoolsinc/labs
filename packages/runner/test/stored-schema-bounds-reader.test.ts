/**
 * Whether a schema stored on a link makes a reader pay for fields it did not
 * declare.
 *
 * A link kept in a document may carry the schema its writer resolved it
 * through, and that schema enumerates everything the row holds. A later
 * reader declares a narrower view — the fields it needs, and no others.
 * Enumerating a field is not a demand that every reader ask for it, so
 * whatever the stored schema says about the rest of the row should cost a
 * reader that declared less exactly nothing.
 */
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("stored schema binds reader");
const space = signer.did();

/** What the reader declares: one field. */
const readerRow = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
} as const satisfies JSONSchema;

/**
 * The writer's schema, enumerating the whole row. Everything it requires is
 * present in the value below — schema and data agree.
 */
const storedPlain = {
  type: "object",
  properties: {
    title: { type: "string" },
    extra: { type: "object", properties: { tag: { type: "string" } } },
  },
  required: ["title", "extra"],
} as const satisfies JSONSchema;

/**
 * The same, except the field the reader never asks for is described by a
 * reference this runtime does not resolve — the shape a pattern's `$UI`
 * takes once its schema has been frozen onto a link.
 */
const storedWithUnresolvableRef = {
  type: "object",
  properties: {
    title: { type: "string" },
    extra: { $ref: "https://commonfabric.org/schemas/vnode.json" },
  },
  required: ["title", "extra"],
} as const satisfies JSONSchema;

const holder = {
  type: "object",
  properties: { rows: { type: "array", items: readerRow } },
} as JSONSchema;

describe("a schema stored on a link, against a reader that declared less", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let seq = 0;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    tx = runtime.edit();
    seq++;
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  /**
   * One row behind a link carrying `stored`. The row holds every field that
   * schema requires, so nothing here turns on a schema disagreeing with its
   * data; the stored schema is the only thing that varies.
   */
  const rowsCellCarrying = (stored: JSONSchema) => {
    const row = runtime.getCell(space, `row-${seq}`, stored, tx);
    row.set({ title: "alpha", extra: { tag: "div" } } as never);
    const list = runtime.getCell(space, `list-${seq}`, holder, tx);
    list.setRaw({ rows: [row.getAsLink({ includeSchema: true })] } as never);
    // The schema really did reach storage; without this the rest is vacuous.
    expect(JSON.stringify(list.getRaw())).toContain("required");
    return list;
  };

  it("reads the declared field when the rest of the stored schema resolves", () => {
    const list = rowsCellCarrying(storedPlain);
    const rows = (list.get() as { rows?: { title?: string }[] }).rows;
    expect(rows?.[0]?.title).toBe("alpha");
  });

  it("hands back only what the reader declared, not the whole stored row", () => {
    const list = rowsCellCarrying(storedPlain);
    const rows = (list.get() as { rows?: Record<string, unknown>[] }).rows;
    // The reader's view is the bound on what comes back: `extra` is stored,
    // and the stored schema enumerates it, but this reader never asked.
    expect(rows?.[0]).toEqual({ title: "alpha" });
  });

  it("reads the declared field when a field it never declared does not resolve", () => {
    const list = rowsCellCarrying(storedWithUnresolvableRef);

    // Reached by its own path, the field the reader wants is right there.
    expect(list.key("rows").key(0).key("title").get()).toBe("alpha");

    // `extra` is present and the stored schema requires it, but the reader
    // declared only `title`. Resolving `extra`'s schema is work this read
    // never asked for, and failing to resolve it must not cost the reader
    // the row — or the whole array it sits in.
    const rows = (list.get() as { rows?: { title?: string }[] }).rows;
    expect(rows).toBeDefined();
    expect(rows?.[0]?.title).toBe("alpha");
  });
});
