import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { SchemaPathSelector } from "@commonfabric/api";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { Identity } from "@commonfabric/identity";
import type { Revision, State } from "@commonfabric/memory/interface";

import { JSONObject, type JSONSchema } from "../src/index.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import {
  CompoundCycleTracker,
  createTraversalContext,
  type CrossTraversalSchemaMemo,
  ManagedStorageTransaction,
  MapSet,
  SchemaObjectTraverser,
  type TraversalContext,
} from "../src/traverse.ts";

const signer = await Identity.fromPassphrase("cross memo test operator");
const space = signer.did();

const TEST_SCOPE_IDENTITY = {
  principal: "did:test:alice",
  sessionId: "session-1",
};

const SCHEMA = {
  type: "object",
  properties: { name: { type: "string" } },
} as const satisfies JSONSchema;

/** Records the seam's calls, and answers `lookup` from whatever the test
 * put there — the memory server's store stands in for this in
 * production. */
class RecordingMemo implements CrossTraversalSchemaMemo {
  readonly calls: string[] = [];
  served: { ok: FabricValue } | undefined = undefined;
  /** Serve only these documents, so a test can leave the root to compute
   * and answer for a subtree it reaches. */
  readonly serveFor = new Map<string, { ok: FabricValue }>();
  throwOnExit = false;
  throwOnExitFor: string | undefined = undefined;

  lookup(doc: { address: { id: string } }) {
    this.calls.push("lookup");
    return this.serveFor.get(doc.address.id) ?? this.served;
  }
  enter() {
    this.calls.push("enter");
  }
  exit(doc: { address: { id: string } }) {
    this.calls.push("exit");
    if (this.throwOnExit || this.throwOnExitFor === doc.address.id) {
      throw new Error("exit failed");
    }
  }
  abandon() {
    this.calls.push("abandon");
  }
  dependency() {
    this.calls.push("dependency");
  }
  poison() {
    this.calls.push("poison");
  }
}

describe("SchemaObjectTraverser cross-traversal memo", () => {
  const store: Map<string, Revision<State>> = new Map();
  let storageTx: IExtendedStorageTransaction;
  let context: TraversalContext;
  let memo: RecordingMemo;
  let doc: Revision<State>;

  beforeEach(() => {
    store.clear();
    storageTx = new ExtendedStorageTransaction(
      new ManagedStorageTransaction(new StoreObjectManager(store)),
    );
    memo = new RecordingMemo();
    context = createTraversalContext(
      new CompoundCycleTracker<FabricValue, JSONSchema | undefined>(),
      new MapSet<string, SchemaPathSelector>(),
      TEST_SCOPE_IDENTITY,
      // The query path: the one arm that may consult the memo.
      true,
    );
    context.crossTraversalMemo = memo;
    doc = {
      the: "application/json",
      of: "of:cross-memo-doc",
      is: { value: { name: "recorded" } },
      since: 1,
    };
    store.set(`${doc.of}/${doc.the}`, doc);
  });

  afterEach(() => {
    store.clear();
  });

  const traverse = () => {
    const traverser = new SchemaObjectTraverser(
      storageTx,
      { path: ["value"], schema: SCHEMA },
      context,
    );
    return traverser.traverse({
      address: {
        space,
        id: doc.of,
        type: doc.the,
        path: ["value"],
      },
      value: (doc.is as JSONObject).value,
    });
  };

  it("frames a computation it could not serve", () => {
    const result = traverse();
    const enters = memo.calls.filter((call) => call === "enter").length;
    const exits = memo.calls.filter((call) => call === "exit").length;
    expect(memo.calls[0]).toBe("lookup");
    // Frames nest with the traversal, and each one that opened closed.
    expect(enters).toBeGreaterThan(0);
    expect(exits).toBe(enters);
    expect(memo.calls).not.toContain("abandon");
    expect((result.ok as { name?: string })?.name).toBe("recorded");
  });

  it("returns a served subtree without computing it", () => {
    memo.served = { ok: { name: "served" } };
    const result = traverse();
    expect(memo.calls).toEqual(["lookup"]);
    expect((result.ok as { name?: string })?.name).toBe("served");
  });

  it("abandons the open frame when completing the computation throws", () => {
    memo.throwOnExit = true;
    expect(() => traverse()).toThrow("exit failed");
    // Every frame the throw unwound through was abandoned rather than
    // left open or stored.
    const enters = memo.calls.filter((call) => call === "enter").length;
    const abandons = memo.calls.filter((call) => call === "abandon").length;
    expect(abandons).toBe(enters);
  });

  it("frames a linked document reached without a schema", () => {
    // A link the reader has no schema for descends through the untyped
    // arm, which is where most of a wide-open query's reach is walked.
    const target: Revision<State> = {
      the: "application/json",
      of: "of:cross-memo-target",
      is: { value: { leaf: "linked" } },
      since: 1,
    };
    store.set(`${target.of}/${target.the}`, target);
    doc = {
      the: "application/json",
      of: "of:cross-memo-referrer",
      is: {
        value: {
          name: "recorded",
          via: { "/": { [LINK_V1_TAG]: { id: target.of, path: [] } } },
        },
      },
      since: 1,
    };
    store.set(`${doc.of}/${doc.the}`, doc);

    const traverser = new SchemaObjectTraverser(
      storageTx,
      { path: ["value"], schema: true },
      context,
    );
    traverser.traverse({
      address: { space, id: doc.of, type: doc.the, path: ["value"] },
      value: (doc.is as JSONObject).value,
    });
    const enters = memo.calls.filter((call) => call === "enter").length;
    const exits = memo.calls.filter((call) => call === "exit").length;
    expect(enters).toBeGreaterThan(0);
    expect(exits).toBe(enters);
  });

  it("returns a served linked subtree without descending into it", () => {
    const target: Revision<State> = {
      the: "application/json",
      of: "of:cross-memo-served-target",
      is: { value: { leaf: "stored" } },
      since: 1,
    };
    store.set(`${target.of}/${target.the}`, target);
    doc = {
      the: "application/json",
      of: "of:cross-memo-served-referrer",
      is: {
        value: {
          via: { "/": { [LINK_V1_TAG]: { id: target.of, path: [] } } },
        },
      },
      since: 1,
    };
    store.set(`${doc.of}/${doc.the}`, doc);
    memo.serveFor.set(target.of, { ok: { leaf: "served" } });

    const traverser = new SchemaObjectTraverser(
      storageTx,
      { path: ["value"], schema: true },
      context,
    );
    const result = traverser.traverse({
      address: { space, id: doc.of, type: doc.the, path: ["value"] },
      value: (doc.is as JSONObject).value,
    });
    // The referrer computed; the target came from the entry rather than
    // from the store.
    expect((result.ok as { via?: { leaf?: string } })?.via?.leaf).toBe(
      "served",
    );
  });

  it("abandons a linked subtree's frame when completing it throws", () => {
    const target: Revision<State> = {
      the: "application/json",
      of: "of:cross-memo-throw-target",
      is: { value: { leaf: "stored" } },
      since: 1,
    };
    store.set(`${target.of}/${target.the}`, target);
    doc = {
      the: "application/json",
      of: "of:cross-memo-throw-referrer",
      is: {
        value: {
          via: { "/": { [LINK_V1_TAG]: { id: target.of, path: [] } } },
        },
      },
      since: 1,
    };
    store.set(`${doc.of}/${doc.the}`, doc);
    memo.throwOnExitFor = target.of;

    const traverser = new SchemaObjectTraverser(
      storageTx,
      { path: ["value"], schema: true },
      context,
    );
    expect(() =>
      traverser.traverse({
        address: { space, id: doc.of, type: doc.the, path: ["value"] },
        value: (doc.is as JSONObject).value,
      })
    ).toThrow("exit failed");
    expect(memo.calls).toContain("abandon");
  });

  it("consults nothing on the read path", () => {
    const readContext = createTraversalContext(
      new CompoundCycleTracker<FabricValue, JSONSchema | undefined>(),
      new MapSet<string, SchemaPathSelector>(),
      TEST_SCOPE_IDENTITY,
      // Read-path results are bound to the materialization that produced
      // them, so this arm never reaches the memo even when one is present.
      false,
    );
    readContext.crossTraversalMemo = memo;
    const traverser = new SchemaObjectTraverser(
      storageTx,
      { path: ["value"], schema: SCHEMA },
      readContext,
    );
    traverser.traverse({
      address: { space, id: doc.of, type: doc.the, path: ["value"] },
      value: (doc.is as JSONObject).value,
    });
    expect(memo.calls).toEqual([]);
  });
});
