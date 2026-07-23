// fabric-safety (#4527): the schema traversal's special-object handling must
// distinguish the two direct subclasses of `FabricSpecialObject`. A
// `FabricPrimitive` (state in private `#fields`, zero enumerable own-props)
// is a fully-opaque leaf. A `FabricInstance` — which can have model-visible
// outgoing references — must fail loudly rather than be silently leafed
// whole or rebuilt as a plain record (stripping its class and codec
// identity), until it can be descended by its codec contents. Covers the
// value-type dispatch's leaf arm and the plain-schema fast path's
// special-object check.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import { hashOf } from "@commonfabric/data-model/value-hash";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import type {
  Entity,
  Revision,
  State,
  URI,
} from "@commonfabric/memory/interface";
import type { SchemaPathSelector } from "@commonfabric/api";

import {
  createDefaultTraversalContext,
  type IMemorySpaceValueAttestation,
  ManagedStorageTransaction,
  SchemaObjectTraverser,
} from "../src/traverse.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";

const traverserOver = (
  uri: string,
  value: FabricValue,
  selector: SchemaPathSelector,
  // `includeMeta: false` (the query path's setting) enables the plain-schema
  // fast path (`traverseCells` gates it off otherwise).
  includeMeta = true,
) => {
  const store = new Map<string, Revision<State>>();
  const type = "application/json" as const;
  const entity = uri as URI as Entity;
  store.set(`${entity}/${type}`, {
    the: type,
    of: entity,
    is: { value },
    cause: hashOf({ the: type, of: entity }),
    since: 1,
  });
  const manager = new StoreObjectManager(store);
  const managedTx = new ManagedStorageTransaction(manager);
  const storeTx = new ExtendedStorageTransaction(managedTx);
  const traverser = new SchemaObjectTraverser(
    storeTx,
    selector,
    createDefaultTraversalContext(includeMeta),
  );
  const doc: IMemorySpaceValueAttestation = {
    address: {
      space: "did:null:null",
      id: uri as URI,
      type,
      path: ["value"],
    },
    value,
  };
  return { traverser, doc };
};

describe("value-type dispatch: FabricSpecialObject subclasses", () => {
  const objectSelector: SchemaPathSelector = {
    path: ["value"],
    schema: {
      type: "object",
      properties: { field: { type: "object" } },
    },
  };

  it("materializes a FabricPrimitive as an opaque leaf (regression pin)", () => {
    const blob = new FabricBytes(new Uint8Array([1, 2, 3]));
    const { traverser, doc } = traverserOver(
      "of:dispatch-primitive",
      { field: blob } as unknown as FabricValue,
      objectSelector,
    );

    const { ok: result } = traverser.traverse(doc);
    expect((result as Record<string, unknown>).field).toBeInstanceOf(
      FabricBytes,
    );
  });

  it("fails loudly on a FabricInstance (not yet handled)", () => {
    // A `FabricInstance` is not a fully-opaque leaf: leafing it whole (as
    // this arm did for any `FabricSpecialObject`) silently hides that its
    // contents were never descended or validated. Fail loudly until
    // codec-contents descent exists.
    const failure = FabricError.fromNativeError(new Error("loud"));
    const { traverser, doc } = traverserOver(
      "of:dispatch-instance",
      { field: failure } as unknown as FabricValue,
      objectSelector,
    );

    expect(() => traverser.traverse(doc)).toThrow(/Cannot yet handle/);
  });
});

describe("plain-schema fast path: FabricSpecialObject subclasses", () => {
  // An array whose item schema compiles to a plain-schema plan (`type` +
  // `properties` with primitive-typed leaves only) routes each element
  // through `traversePlainSchemaWithReads`.
  const planSelector: SchemaPathSelector = {
    path: ["value"],
    schema: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" } },
      },
    },
  };

  it("materializes a FabricPrimitive element as an opaque leaf (regression pin)", () => {
    const blob = new FabricBytes(new Uint8Array([7, 7]));
    const { traverser, doc } = traverserOver(
      "of:plan-primitive",
      [blob] as unknown as FabricValue,
      planSelector,
      false,
    );

    const { ok: result } = traverser.traverse(doc);
    expect((result as unknown[])[0]).toBeInstanceOf(FabricBytes);
  });

  it("fails loudly on a FabricInstance element (not yet handled)", () => {
    const failure = FabricError.fromNativeError(new Error("loud"));
    const { traverser, doc } = traverserOver(
      "of:plan-instance",
      [failure] as unknown as FabricValue,
      planSelector,
      false,
    );

    expect(() => traverser.traverse(doc)).toThrow(/Cannot yet handle/);
  });
});
