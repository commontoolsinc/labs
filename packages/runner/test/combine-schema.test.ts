/**
 * Pins for `combineSchema`'s additionalProperties default.
 *
 * When a link carries a schema and a reader brings its own, `combineSchema`
 * intersects them. The default for an ABSENT `additionalProperties` must be
 * open (`true`), per JSON Schema: listing `properties` without
 * `additionalProperties` does not close the object.
 *
 * The bug (topic "combineSchema manufactures closed-world additionalProperties",
 * confirmed by seefeld): the default was `properties === undefined`, so any
 * object that listed `properties` was treated as closed-world `false`. A field
 * the link had simply never heard of combined to a statically-unsatisfiable
 * `false` subschema; if the reader still required it, the read voided forever.
 *
 * An explicitly authored `additionalProperties: false` still closes the world —
 * `undefined` (open) and `false` (closed) are not the same thing.
 *
 * The first block pins the pure function; the second drives the real traverser
 * to prove the read-through-a-link void actually heals.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { hashOf } from "@commonfabric/data-model/value-hash";
import type { SchemaPathSelector } from "@commonfabric/api";
import type {
  Entity,
  Revision,
  State,
  URI,
} from "@commonfabric/memory/interface";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import {
  combineSchema,
  ManagedStorageTransaction,
  SchemaObjectTraverser,
} from "../src/traverse.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";

const S = (schema: JSONSchema) => schema;

describe("combineSchema additionalProperties default", () => {
  it("preserves a reader-only field the link never knew (open-world default)", () => {
    // The evolved reader knows {a,b,c} and requires all three.
    const reader = S({
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "string" },
        c: { type: "string" },
      },
      required: ["a", "b", "c"],
    });
    // The older link carried only {a}, with no explicit additionalProperties.
    const link = S({
      type: "object",
      properties: { a: { type: "string" } },
    });

    const merged = combineSchema(reader, link) as {
      properties: Record<string, JSONSchema>;
      required?: string[];
    };

    // The reader's full requirement survives (link brought no `required`).
    expect(merged.required).toEqual(["a", "b", "c"]);
    // b and c must keep the reader's schema, NOT collapse to `false`.
    expect(merged.properties.b).not.toBe(false);
    expect(merged.properties.c).not.toBe(false);
    expect(merged.properties.b).toEqual({ type: "string" });
    expect(merged.properties.c).toEqual({ type: "string" });
    // No required property may be a statically-unsatisfiable `false` subschema.
    for (const key of merged.required ?? []) {
      expect(merged.properties[key]).not.toBe(false);
    }
  });

  it("still closes the world for an explicitly authored additionalProperties:false", () => {
    // `undefined` (open) and `false` (closed) are different: an authored
    // closed-world link legitimately makes a field it lacks unsatisfiable.
    const reader = S({
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "string" },
      },
      required: ["a", "b"],
    });
    const link = S({
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    });

    const merged = combineSchema(reader, link) as {
      properties: Record<string, JSONSchema>;
    };

    expect(merged.properties.b).toBe(false);
  });

  it("keeps a link-only field (never the bite; unchanged by the default)", () => {
    const reader = S({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    });
    const link = S({
      type: "object",
      properties: {
        a: { type: "string" },
        d: { type: "number" },
      },
    });

    const merged = combineSchema(reader, link) as {
      properties: Record<string, JSONSchema>;
    };

    expect(merged.properties.d).toEqual({ type: "number" });
  });

  it("intersects required when both sides carry it (the bite vanishes)", () => {
    // Documents why the bug only bit links that omitted `required`.
    const reader = S({
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "string" },
        c: { type: "string" },
      },
      required: ["a", "b", "c"],
    });
    const link = S({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    });

    const merged = combineSchema(reader, link) as { required?: string[] };

    // Only the shared requirement survives, so nothing the link lacked is
    // required — no unsatisfiable void even under the old closed default.
    expect(merged.required).toEqual(["a"]);
  });

  it("leaves an open (property-less) side alone", () => {
    // properties === undefined: old and new defaults coincide (both open).
    const reader = S({ type: "object" });
    const link = S({
      type: "object",
      properties: { a: { type: "string" } },
    });

    const merged = combineSchema(reader, link) as {
      properties?: Record<string, JSONSchema>;
    };

    expect(merged.properties?.a).toEqual({ type: "string" });
  });
});

// --- Integration: prove the read-through-a-link void heals ------------------

const TYPE = "application/json" as const;
const SPACE = "did:null:null";

function getTraverser(
  store: Map<string, Revision<State>>,
  selector: SchemaPathSelector,
): SchemaObjectTraverser<FabricValue> {
  const manager = new StoreObjectManager(store);
  const managedTx = new ManagedStorageTransaction(manager);
  const tx = new ExtendedStorageTransaction(managedTx);
  return new SchemaObjectTraverser(tx, selector);
}

function putDoc(
  store: Map<string, Revision<State>>,
  uri: URI,
  value: unknown,
  since = 1,
): void {
  const revision: Revision<State> = {
    the: TYPE,
    of: uri as Entity,
    is: { value },
    cause: hashOf({ the: TYPE, of: uri as Entity }),
    since,
  };
  store.set(`${revision.of}/${revision.the}`, revision);
}

const linkTo = (id: URI, path: string[] = [], schema?: JSONSchema) => ({
  "/": { [LINK_V1_TAG]: { id, path, ...(schema !== undefined && { schema }) } },
});

function traverseRoot(
  store: Map<string, Revision<State>>,
  rootUri: URI,
  rootValue: unknown,
  schema: JSONSchema,
) {
  const traverser = getTraverser(store, { path: ["value"], schema });
  return traverser.traverse({
    address: { space: SPACE, id: rootUri, type: TYPE, path: ["value"] },
    value: rootValue as FabricValue,
  });
}

describe("combineSchema read-through-link (integration)", () => {
  const rootUri = "of:combine-root" as URI;
  const targetUri = "of:combine-target" as URI;

  it("heals a read through an older link schema that never knew a now-required field", () => {
    const store = new Map<string, Revision<State>>();
    // The real doc holds all three fields.
    putDoc(store, targetUri, { a: "x", b: "y", c: "z" });
    // Root points at the target through a link carrying the OLDER schema: it
    // knew only `a`, with no `required` and no explicit additionalProperties.
    const olderLinkSchema = S({
      type: "object",
      properties: { a: { type: "string" } },
    });
    const rootValue = { item: linkTo(targetUri, [], olderLinkSchema) };
    putDoc(store, rootUri, rootValue);
    // The evolved reader knows and requires a, b, c.
    const readerSchema = S({
      type: "object",
      properties: {
        item: {
          type: "object",
          properties: {
            a: { type: "string" },
            b: { type: "string" },
            c: { type: "string" },
          },
          required: ["a", "b", "c"],
        },
      },
      required: ["item"],
    });

    const { ok: result, error } = traverseRoot(
      store,
      rootUri,
      rootValue,
      readerSchema,
    );

    // Pre-fix: `item`'s combined schema required b,c but manufactured them as
    // `false` — unsatisfiable — so the whole read voided. Post-fix: the open
    // default preserves b,c and the read returns the data.
    expect(error).toBeUndefined();
    expect(result).toEqual({ item: { a: "x", b: "y", c: "z" } });
  });
});
