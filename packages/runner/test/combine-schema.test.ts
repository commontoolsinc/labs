/**
 * Pins for `combineSchema`'s handling of an absent `additionalProperties`.
 *
 * Our schemas double as QUERIES, so `additionalProperties` is three-valued
 * (see SchemaObjectTraverser.traverseObjectWithSchema):
 *   - `false`      → forbid extras: a field the side lacks is unsatisfiable
 *                    (the CFC visibility boundary — "you may not see this").
 *   - `true`       → accept and WALK any extra field.
 *   - `undefined`  → when `properties` is listed, IGNORE extras: return the
 *                    listed fields, tolerate but neither return nor walk the
 *                    rest. When NO `properties` are listed, the shape is
 *                    unknown, so absent means open (`true`): walk everything.
 *
 * When a link carries a schema and a reader brings its own, `combineSchema`
 * merges them. A field only ONE side names is governed by the OTHER side's
 * `additionalProperties`, and the three values must stay distinct:
 *
 *   - A field the READER requires but the link merely IGNORES (undefined) keeps
 *     the reader's schema — the link tolerates it, so the reader's explicit
 *     interest wins and the read heals (the bug turned this into a `false`
 *     void; topic "combineSchema manufactures closed-world additionalProperties",
 *     confirmed by seefeld + ubik2).
 *   - A field only the LINK names, which the reader IGNORES, is dropped — the
 *     reader's projection decides what is returned and walked, so we must not
 *     descend into it (the friends-of-friends over-walk ubik2 flagged; a naive
 *     `true` default would walk it).
 *   - An explicitly authored `additionalProperties: false` still forbids a
 *     field the side lacks — `undefined` and `false` are not the same thing.
 *
 * The first block pins the pure function; the second drives the real traverser
 * to prove both the heal AND that the ignored link-only field is never walked.
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
  it("keeps a reader-only field the link merely ignores (heals; link tolerates, does not forbid)", () => {
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
    // The older link carried only {a}, with no explicit additionalProperties,
    // so it IGNORES (does not forbid) b and c.
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
    // b and c keep the reader's schema, NOT collapse to `false`.
    expect(merged.properties.b).toEqual({ type: "string" });
    expect(merged.properties.c).toEqual({ type: "string" });
    // No required property may be a statically-unsatisfiable `false` subschema.
    for (const key of merged.required ?? []) {
      expect(merged.properties[key]).not.toBe(false);
    }
  });

  it("still forbids for an explicitly authored additionalProperties:false", () => {
    // `undefined` (ignore) and `false` (forbid) are different: an authored
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

  it("drops a link-only field the reader never asked for (projection wins, no over-walk)", () => {
    // The reader projects only {a}: it lists `properties` and no
    // additionalProperties, so it IGNORES anything else. A field the link
    // carries but the reader never named must be dropped — keeping it would
    // return, and walk, data the reader never asked for.
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

    // d is the link's field; the reader ignored it, so it is absent from the
    // merged query and will be neither returned nor walked.
    expect("d" in merged.properties).toBe(false);
    expect(merged.properties.d).toBeUndefined();
    // The field the reader did ask for survives.
    expect(merged.properties.a).toEqual({ type: "string" });
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
    // properties === undefined: the side's shape is unknown, so absent
    // additionalProperties means open (`true`) — walk what the other side has.
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

// --- Integration: the read heals, and the ignored field is never walked -----

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
    // `false` — unsatisfiable — so the whole read voided. Post-fix: the link
    // merely ignored b,c, so the reader's schema wins and the read returns.
    expect(error).toBeUndefined();
    expect(result).toEqual({ item: { a: "x", b: "y", c: "z" } });
  });

  it("does not walk a link-only field the reader never asked for (no over-walk)", () => {
    const store = new Map<string, Revision<State>>();
    // A separate doc that must NOT be walked: reaching it proves over-walk.
    const friendsUri = "of:combine-friends" as URI;
    putDoc(store, friendsUri, ["bob", "carol", "dave"]);
    // The person doc holds a name and a LINK to the friends list.
    putDoc(store, targetUri, {
      name: "alice",
      friends: linkTo(friendsUri),
    });
    // Root reaches the person through a link whose schema is BROAD — it knows
    // about both `name` and `friends`.
    const broadLinkSchema = S({
      type: "object",
      properties: {
        name: { type: "string" },
        friends: { type: "array", items: { type: "string" } },
      },
    });
    const rootValue = { person: linkTo(targetUri, [], broadLinkSchema) };
    putDoc(store, rootUri, rootValue);
    // The reader PROJECTS only { name } — it never asks for friends.
    const readerSchema = S({
      type: "object",
      properties: {
        person: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      },
      required: ["person"],
    });

    const { ok: result, error } = traverseRoot(
      store,
      rootUri,
      rootValue,
      readerSchema,
    );

    // The read succeeds and returns the projected `name`. `friends` — the
    // link-only field the reader ignored — is NOT walked: the traverser
    // surfaces the raw, UNFOLLOWED link rather than resolving it. A `true`
    // default would follow it (yielding ["bob","carol","dave"]) and, on a real
    // graph, walk friends-of-friends — the server-breaking case ubik2 flagged.
    expect(error).toBeUndefined();
    const person = (result as { person: Record<string, unknown> }).person;
    expect(person.name).toBe("alice");
    expect(person.friends).not.toEqual(["bob", "carol", "dave"]);
    // friends is present only as an unfollowed link sigil, never traversed.
    expect((person.friends as Record<string, unknown>)["/"]).toBeDefined();
  });
});
