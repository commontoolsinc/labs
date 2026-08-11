// The schema-observing lazy view, reached through `Cell.get()` on a
// transaction marked for lazy materialization.
//
// Two properties carry most of the confidence: a view agrees with an eager read
// on what the value is, and it reads only what the reader touches. The rest
// covers the refusal contract — where a mismatch surfaces, and where it does
// not.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { isSchemaMismatchError } from "../src/schema-view.ts";
import { type JSONSchema } from "../src/builder/types.ts";
import { getTransactionReadActivities } from "../src/storage/transaction-inspection.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("schema-view");
const space = signer.did();

describe("schema-view", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });
  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** Seed a cell, then hand back a reader bound to a fresh transaction. */
  const seeded = async (
    cause: string,
    value: unknown,
    schema: JSONSchema,
  ) => {
    const write = runtime.edit();
    runtime.getCell(space, cause, undefined, write).set(value);
    await write.commit();

    const read = (lazy: boolean): {
      tx: IExtendedStorageTransaction;
      get: () => unknown;
    } => {
      const tx = runtime.edit();
      if (lazy) tx.markLazyMaterialize(true);
      const cell = runtime.getCell(space, cause, schema, tx);
      return { tx, get: () => cell.get() };
    };
    return read;
  };

  const pathsRead = (tx: IExtendedStorageTransaction): string[] =>
    [...getTransactionReadActivities(tx) ?? []].map((activity) =>
      activity.path.join("/")
    );

  /** `<id>/<path>` for plain recursive content reads — no probe, verifier or
   * ignore marker on them. Link resolution's own probes are marked and answer a
   * different question ("is there a link here?"), so this is the set that says
   * what the reader took a dependency on. */
  const contentReads = (tx: IExtendedStorageTransaction): string[] =>
    [...getTransactionReadActivities(tx) ?? []]
      .filter((activity) =>
        activity.nonRecursive !== true &&
        Object.getOwnPropertySymbols(activity.meta ?? {}).length === 0
      )
      .map((activity) => `${activity.id}/${activity.path.join("/")}`);

  describe("agreement with an eager read", () => {
    const cases: Array<[string, unknown, JSONSchema]> = [
      [
        "a flat record",
        { a: 1, b: "two" },
        {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "string" } },
        } as const,
      ],
      [
        "a nested record",
        { outer: { inner: { leaf: 7 } } },
        {
          type: "object",
          properties: {
            outer: {
              type: "object",
              properties: {
                inner: {
                  type: "object",
                  properties: { leaf: { type: "number" } },
                },
              },
            },
          },
        } as const,
      ],
      [
        "an array of scalars",
        { xs: [1, 2, 3] },
        {
          type: "object",
          properties: { xs: { type: "array", items: { type: "number" } } },
        } as const,
      ],
      [
        "an array of records",
        { xs: [{ n: 1 }, { n: 2 }] },
        {
          type: "object",
          properties: {
            xs: {
              type: "array",
              items: { type: "object", properties: { n: { type: "number" } } },
            },
          },
        } as const,
      ],
      [
        "a property the schema does not select",
        { a: 1, hidden: 2 },
        {
          type: "object",
          properties: { a: { type: "number" } },
        } as const,
      ],
      [
        "a declared default for an absent property",
        { a: 1 },
        {
          type: "object",
          properties: {
            a: { type: "number" },
            b: { type: "string", default: "fallback" },
          },
        } as const,
      ],
      [
        "a matching anyOf branch",
        { kind: "circle", radius: 2 },
        {
          type: "object",
          properties: {
            kind: { type: "string" },
            radius: { type: "number" },
          },
          anyOf: [
            { type: "object", required: ["radius"] },
            { type: "object", required: ["side"] },
          ],
        } as const,
      ],
      [
        // The branch narrowing picks says nothing about `radius`; the schema
        // around the union does, and it applies to whichever branch matched.
        "a property the union's own schema rejects",
        { kind: "circle", radius: "bad" },
        {
          type: "object",
          properties: {
            kind: { type: "string" },
            radius: { type: "number" },
          },
          anyOf: [
            { type: "object", required: ["kind"] },
            { type: "object", required: ["side"] },
          ],
        } as const,
      ],
    ];

    for (const [name, value, schema] of cases) {
      it(`returns the same value as an eager read for ${name}`, async () => {
        const read = await seeded(`agree-${name}`, value, schema);
        const eager = read(false);
        const lazy = read(true);
        try {
          expect(JSON.parse(JSON.stringify(lazy.get()))).toEqual(
            JSON.parse(JSON.stringify(eager.get())),
          );
        } finally {
          await eager.tx.commit();
          await lazy.tx.commit();
        }
      });
    }
  });

  describe("reading only what is touched", () => {
    it("registers no read for a sibling the reader never looks at", async () => {
      const read = await seeded(
        "frugal",
        {
          wanted: { leaf: 1 },
          untouched: { leaf: 2 },
        },
        {
          type: "object",
          properties: {
            wanted: {
              type: "object",
              properties: { leaf: { type: "number" } },
            },
            untouched: {
              type: "object",
              properties: { leaf: { type: "number" } },
            },
          },
        } as const,
      );

      const lazy = read(true);
      const value = lazy.get() as { wanted: { leaf: number } };
      expect(value.wanted.leaf).toBe(1);
      const lazyPaths = pathsRead(lazy.tx);
      await lazy.tx.commit();

      const eager = read(false);
      eager.get();
      const eagerPaths = pathsRead(eager.tx);
      await eager.tx.commit();

      expect(lazyPaths.some((path) => path.includes("untouched"))).toBe(false);
      expect(eagerPaths.some((path) => path.includes("untouched"))).toBe(true);
    });

    it("registers no read for an array element the reader never looks at", async () => {
      const read = await seeded(
        "frugal-array",
        {
          xs: [{ n: 1 }, { n: 2 }, { n: 3 }],
        },
        {
          type: "object",
          properties: {
            xs: {
              type: "array",
              items: { type: "object", properties: { n: { type: "number" } } },
            },
          },
        } as const,
      );

      const lazy = read(true);
      const value = lazy.get() as { xs: { n: number }[] };
      expect(value.xs.length).toBe(3);
      expect(value.xs[0].n).toBe(1);
      const paths = pathsRead(lazy.tx);
      await lazy.tx.commit();

      // An element is its own document, so the element's own fields are read
      // under that document rather than under `xs/<i>`. What the slot read
      // shows is which elements were reached at all.
      expect(paths.some((path) => path.endsWith("xs/0"))).toBe(true);
      expect(paths.some((path) => path.endsWith("xs/2"))).toBe(false);
    });
  });

  describe("refusal", () => {
    it("returns undefined when the root is missing a required property", async () => {
      const read = await seeded(
        "root-required",
        { b: 1 },
        {
          type: "object",
          required: ["a"],
          properties: { a: { type: "number" }, b: { type: "number" } },
        } as const,
      );

      const lazy = read(true);
      const eager = read(false);
      try {
        expect(lazy.get()).toBeUndefined();
        expect(eager.get()).toBeUndefined();
      } finally {
        await lazy.tx.commit();
        await eager.tx.commit();
      }
    });

    it("throws when the reader touches a nested missing required property", async () => {
      const read = await seeded(
        "nested-required",
        { inner: { b: 1 } },
        {
          type: "object",
          required: ["inner"],
          properties: {
            inner: {
              type: "object",
              required: ["a"],
              properties: { a: { type: "number" }, b: { type: "number" } },
            },
          },
        } as const,
      );

      const lazy = read(true);
      try {
        const value = lazy.get() as { inner: unknown };
        let thrown: unknown;
        try {
          value.inner;
        } catch (error) {
          thrown = error;
        }
        expect(isSchemaMismatchError(thrown)).toBe(true);
      } finally {
        await lazy.tx.commit();
      }
    });

    it("throws when the reader touches a required value of the wrong type", async () => {
      const read = await seeded(
        "wrong-type-required",
        { n: "not a number" },
        {
          type: "object",
          required: ["n"],
          properties: { n: { type: "number" } },
        } as const,
      );

      const lazy = read(true);
      try {
        const value = lazy.get() as { n: unknown };
        expect(() => value.n).toThrow("Schema mismatch");
      } finally {
        await lazy.tx.commit();
      }
    });

    it("reads an optional value of the wrong type as undefined, as an eager read does", async () => {
      // An eager read leaves a property whose traversal fails out of the
      // object; only a `required` one takes the object down with it. Refusing
      // an optional one instead would stop a reader the eager path runs.
      const read = await seeded(
        "wrong-type-optional",
        { n: "not a number", ok: 1 },
        {
          type: "object",
          properties: { n: { type: "number" }, ok: { type: "number" } },
        } as const,
      );

      const eager = read(false);
      const lazy = read(true);
      try {
        expect((eager.get() as { n: unknown }).n).toBeUndefined();
        expect((lazy.get() as { n: unknown }).n).toBeUndefined();
        expect((lazy.get() as { ok: number }).ok).toBe(1);
        // Nothing was refused, so the run is not disposed of as an argument
        // that did not resolve.
        expect(lazy.tx.takeSchemaRefusal()).toBeUndefined();
      } finally {
        await eager.tx.commit();
        await lazy.tx.commit();
      }
    });

    it("runs on past a mismatch in a subtree the reader never touches", async () => {
      // The one behavior change a pattern author can observe: an eager read
      // collapses the whole value, a view hands back what was asked for.
      const read = await seeded(
        "untouched-mismatch",
        {
          wanted: 1,
          broken: { b: 1 },
        },
        {
          type: "object",
          properties: {
            wanted: { type: "number" },
            broken: {
              type: "object",
              required: ["a"],
              properties: { a: { type: "number" } },
            },
          },
        } as const,
      );

      const eager = read(false);
      const lazy = read(true);
      try {
        // Eager: `broken` fails, so it is dropped, and `wanted` survives —
        // the collapse only reaches the whole value when the failing property
        // is itself required.
        expect((eager.get() as { wanted: number }).wanted).toBe(1);
        expect((lazy.get() as { wanted: number }).wanted).toBe(1);
      } finally {
        await eager.tx.commit();
        await lazy.tx.commit();
      }
    });

    it("registers the read that failed, so the reader runs again when it arrives", async () => {
      const read = await seeded(
        "registers-failure",
        { inner: { b: 1 } },
        {
          type: "object",
          required: ["inner"],
          properties: {
            inner: {
              type: "object",
              required: ["a"],
              properties: { a: { type: "number" } },
            },
          },
        } as const,
      );

      const lazy = read(true);
      try {
        const value = lazy.get() as { inner: unknown };
        try {
          value.inner;
        } catch {
          // The refusal is the point; what matters is what it left behind.
        }
        expect(pathsRead(lazy.tx).some((path) => path.endsWith("inner")))
          .toBe(true);
      } finally {
        await lazy.tx.commit();
      }
    });
  });

  describe("handles", () => {
    // An optional handle — `Cell<T> | undefined` — generates as a union whose
    // one branch carries `asCell` and whose other is the absent case, and the
    // branches arrive as `$ref`s into `$defs`. Both facts hid the marker: a
    // union answers `hasAsCell` only when EVERY branch declares one, and a bare
    // `$ref` declares nothing until it is resolved. A reader got a plain value
    // where the pattern declared a handle.
    it("returns a Cell for an optional handle declared through $ref branches", async () => {
      const read = await seeded(
        "optional-handle",
        { entry: { origin: "sent", author: { name: "ada" } } },
        {
          $defs: {
            Author: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
            Sent: {
              type: "object",
              required: ["origin", "author"],
              properties: {
                origin: { type: "string" },
                author: {
                  anyOf: [
                    { anyOf: [{ $ref: "#/$defs/Author" }], asCell: ["cell"] },
                    {
                      anyOf: [
                        { type: "undefined" },
                        {
                          anyOf: [{ $ref: "#/$defs/Author" }],
                          asCell: ["cell"],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
          type: "object",
          properties: { entry: { $ref: "#/$defs/Sent" } },
        } as const,
      );

      const lazy = read(true);
      const eager = read(false);
      try {
        const lazyAuthor =
          (lazy.get() as { entry: { author: { get?: unknown } } }).entry.author;
        const eagerAuthor =
          (eager.get() as { entry: { author: { get?: unknown } } }).entry
            .author;
        expect(typeof eagerAuthor?.get).toBe("function");
        expect(typeof lazyAuthor?.get).toBe("function");
      } finally {
        await lazy.tx.commit();
        await eager.tx.commit();
      }
    });
  });

  describe("once the transaction has written", () => {
    it("stays lazy after a write batch that staged nothing", async () => {
      const read = await seeded(
        "empty-batch",
        { a: 1, untouched: { leaf: 2 } },
        {
          type: "object",
          properties: {
            a: { type: "number" },
            untouched: {
              type: "object",
              properties: { leaf: { type: "number" } },
            },
          },
        } as const,
      );

      const lazy = read(true);
      try {
        lazy.tx.writeValuesOrThrow([]);
        expect((lazy.get() as { a: number }).a).toBe(1);
        // Eager materialization would have walked the sibling; a view that is
        // still lazy never looks at it.
        expect(pathsRead(lazy.tx).some((path) => path.includes("untouched")))
          .toBe(false);
      } finally {
        await lazy.tx.commit();
      }
    });

    // A view resolves each path when it is touched, so a read taken after a
    // write would report the new value where an eager read hands back one
    // detached at the moment it was taken. A read is materialized eagerly once
    // the transaction has written, so it describes the same instant either way.
    //
    // This covers a read taken AFTER a write. A view handed out BEFORE one
    // still tracks it, which the write epoch in the plan is what fixes.
    it("materializes eagerly for a read taken after a write", async () => {
      const readAfterWrite = async (lazy: boolean) => {
        const cause = `read-after-write-${lazy}`;
        const write = runtime.edit();
        runtime.getCell(space, cause, undefined, write).set({ n: 1 });
        await write.commit();

        const tx = runtime.edit();
        if (lazy) tx.markLazyMaterialize(true);
        const schema = {
          type: "object",
          properties: { n: { type: "number" } },
        } as const;
        const cell = runtime.getCell(space, cause, schema, tx);
        cell.key("n").set(99);
        // Taken after the write, so it is detached at this instant and does
        // not move when the value is written again.
        const value = cell.get() as { n: number };
        const seen = value.n;
        cell.key("n").set(7);
        const afterSecondWrite = value.n;
        await tx.commit();
        return { seen, afterSecondWrite };
      };

      expect(await readAfterWrite(true)).toEqual(await readAfterWrite(false));
    });

    it("still reads back what a lift wrote through a handle it was passed", async () => {
      const readBack = async (lazy: boolean) => {
        const cause = `write-then-read-${lazy}`;
        const write = runtime.edit();
        runtime.getCell(space, cause, undefined, write).set({
          scratch: { n: 1 },
        });
        await write.commit();

        const tx = runtime.edit();
        if (lazy) tx.markLazyMaterialize(true);
        const argument = runtime.getCell(
          space,
          cause,
          {
            type: "object",
            properties: {
              scratch: {
                type: "object",
                properties: { n: { type: "number" } },
                asCell: ["cell"],
              },
            },
          } as const,
          tx,
        ).get() as {
          scratch: { set: (v: unknown) => void; get: () => { n: number } };
        };

        argument.scratch.set({ n: 42 });
        const seen = argument.scratch.get()?.n;
        await tx.commit();
        return seen;
      };

      expect(await readBack(true)).toBe(42);
      expect(await readBack(false)).toBe(42);
    });
  });

  describe("a value that is not there", () => {
    it("takes the schema's declared default", async () => {
      const read = await seeded(
        "declared-default",
        undefined,
        {
          type: ["array", "undefined"],
          items: { type: "number" },
          default: [],
        },
      );

      const eager = read(false);
      const lazy = read(true);
      try {
        expect(eager.get()).toEqual([]);
        expect(lazy.get()).toEqual([]);
      } finally {
        await eager.tx.commit();
        await lazy.tx.commit();
      }
    });

    it("registers the read the default stands in for", async () => {
      // The value that will fill this slot arrives in a document of its own —
      // a computed's result — so resolving the link leaves no dependency on it.
      // Without one the reader keeps reading the default however late the
      // value arrives.
      const write = runtime.edit();
      const target = runtime.getCell<number>(
        space,
        "default-dependency-target",
        undefined,
        write,
      );
      const holder = runtime.getCell<Record<string, unknown>>(
        space,
        "default-dependency-holder",
        undefined,
        write,
      );
      holder.setRaw({ x: target.getAsLink() });
      const arg = runtime.getCell<Record<string, unknown>>(
        space,
        "default-dependency",
        undefined,
        write,
      );
      arg.setRaw({ n: holder.key("x").getAsLink() });
      await write.commit();

      const tx = runtime.edit();
      tx.markLazyMaterialize(true);
      try {
        const value = runtime.getCell(
          space,
          "default-dependency",
          {
            type: "object",
            properties: { n: { type: ["number", "undefined"], default: 7 } },
          } as const,
          tx,
        ).get() as { n: number };
        expect(value.n).toBe(7);
        const targetId = target.getAsNormalizedFullLink().id;
        expect(contentReads(tx).filter((read) => read.startsWith(targetId)))
          .toContain(`${targetId}/value`);
      } finally {
        await tx.commit();
      }
    });
  });

  describe("a $ref the schema cannot resolve", () => {
    it("matches nothing where it is a branch of a union", async () => {
      const read = await seeded(
        "unresolvable-branch",
        { inner: { a: 1 } },
        {
          type: "object",
          properties: {
            inner: {
              anyOf: [
                { $ref: "#/$defs/Missing" },
                { type: "object", required: ["never"] },
              ],
            },
          },
        } as const,
      );

      const eager = read(false);
      const lazy = read(true);
      try {
        // Neither branch can describe this value: one names a definition the
        // schema does not carry, the other requires a key it does not have.
        expect((eager.get() as { inner?: { a?: number } }).inner?.a)
          .toBeUndefined();
        expect((lazy.get() as { inner?: { a?: number } }).inner?.a)
          .toBeUndefined();
      } finally {
        await eager.tx.commit();
        await lazy.tx.commit();
      }
    });

    it("matches everything where the definition it names is `true`", async () => {
      // A boolean target is a resolution, not a failure to resolve.
      const read = await seeded(
        "permissive-ref",
        { inner: { a: 1 } },
        {
          type: "object",
          properties: {
            inner: {
              anyOf: [
                { $ref: "#/$defs/Anything" },
                { type: "object", required: ["never"] },
              ],
            },
          },
          $defs: { Anything: true },
        } as const,
      );

      const eager = read(false);
      const lazy = read(true);
      try {
        expect((eager.get() as { inner?: { a?: number } }).inner?.a).toBe(1);
        expect((lazy.get() as { inner?: { a?: number } }).inner?.a).toBe(1);
      } finally {
        await eager.tx.commit();
        await lazy.tx.commit();
      }
    });

    it("matches nothing where it is the whole schema", async () => {
      const read = await seeded(
        "unresolvable-root",
        { a: 1 },
        { $ref: "#/$defs/Missing" } as const,
      );

      const eager = read(false);
      const lazy = read(true);
      try {
        // A schema the runtime cannot read is not the same as no schema, which
        // would hand back the value untouched.
        expect(eager.get()).toBeUndefined();
        expect(lazy.get()).toBeUndefined();
      } finally {
        await eager.tx.commit();
        await lazy.tx.commit();
      }
    });
  });

  describe("a link that carries a schema of its own", () => {
    it("keeps the property the reader asked for and the link's schema does not name", async () => {
      // Crossing a link is where an eager read combines the link's schema into
      // the selector: the link's schema describes the value at its target, the
      // reader's describes what the reader asked for, and both apply.
      const write = runtime.edit();
      const piece = runtime.getCell<Record<string, unknown>>(
        space,
        "link-schema-piece",
        { type: "object", properties: { isHidden: { type: "boolean" } } },
        write,
      );
      piece.setRaw({ isHidden: false, title: "Linked" });
      const arg = runtime.getCell<Record<string, unknown>>(
        space,
        "link-schema-arg",
        undefined,
        write,
      );
      arg.setRaw({ p: piece.getAsLink({ includeSchema: true }) });
      await write.commit();

      const schema = {
        type: "object",
        properties: {
          p: { type: "object", properties: { title: { type: "string" } } },
        },
      } as const;
      const readBack = async (lazy: boolean) => {
        const tx = runtime.edit();
        if (lazy) tx.markLazyMaterialize(true);
        const seen = (runtime.getCell(space, "link-schema-arg", schema, tx)
          .get() as { p: { title: string } }).p.title;
        await tx.commit();
        return seen;
      };

      expect(await readBack(false)).toBe("Linked");
      expect(await readBack(true)).toBe("Linked");
    });
  });

  describe("a link that ends at a string's length", () => {
    it("reads the length of the string it points at", async () => {
      // `.length` on a string output lowers to a link ending in that segment,
      // and it is the one address computed rather than stored.
      const write = runtime.edit();
      const target = runtime.getCell<string>(
        space,
        "length-target",
        undefined,
        write,
      );
      target.set("Total: 0");
      const holder = runtime.getCell<Record<string, unknown>>(
        space,
        "length-holder",
        undefined,
        write,
      );
      holder.setRaw({ label: target.getAsLink() });
      const arg = runtime.getCell<Record<string, unknown>>(
        space,
        "length-arg",
        undefined,
        write,
      );
      arg.setRaw({ n: holder.key("label", "length").getAsLink() });
      await write.commit();

      const schema = {
        type: "object",
        properties: { n: { type: "number" } },
        required: ["n"],
      } as const;
      const readBack = async (lazy: boolean) => {
        const tx = runtime.edit();
        if (lazy) tx.markLazyMaterialize(true);
        const seen = (runtime.getCell(space, "length-arg", schema, tx)
          .get() as { n: number }).n;
        await tx.commit();
        return seen;
      };

      expect(await readBack(false)).toBe(8);
      expect(await readBack(true)).toBe(8);
    });
  });

  describe("a view is a read", () => {
    it("refuses assignment", async () => {
      const read = await seeded(
        "no-assign",
        { a: 1 },
        {
          type: "object",
          properties: { a: { type: "number" } },
        } as const,
      );
      const lazy = read(true);
      try {
        const value = lazy.get() as { a: number };
        expect(() => {
          value.a = 2;
        }).toThrow("it is a read");
      } finally {
        await lazy.tx.commit();
      }
    });
  });
});
