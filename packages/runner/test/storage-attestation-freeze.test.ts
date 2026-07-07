/**
 * CT-1840 contract pins: data:-URI reads return deep-frozen, identity-stable
 * values.
 *
 * Every dependency-collection traversal of a pattern's argument closure is
 * rooted at a `data:` URI cell. If `attestation.load` hands out unfrozen
 * values, the embedded link schemas fail the frozen-only gates on the
 * identity-keyed schema/hash memos and the runner re-hashes/re-traverses
 * everything per touch. If it hands out a FRESH parse per call (the old
 * 1000-entry LRU cycling under >1000 distinct URIs), every identity-keyed
 * cache downstream misses the same way. These tests pin both properties.
 */

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { load } from "../src/storage/transaction/attestation.ts";
import { setAssertFrozenReadsForTesting } from "../src/storage/transaction/chronicle.ts";
import { isDeepFrozen } from "@commonfabric/data-model/deep-freeze";
import { cloneIfNecessary } from "@commonfabric/data-model/value-clone";
import * as Transaction from "../src/storage/transaction.ts";
import type {
  FabricValue,
  ISpaceReplica,
  IStorageManager,
  MemorySpace,
  Signer,
} from "../src/storage/interface.ts";
import type { Cell } from "../src/cell.ts";

// Mirrors Runtime.getImmutableCell's mint: percent-encoded JSON payload.
const dataURI = (value: unknown): string =>
  `data:application/json,${encodeURIComponent(JSON.stringify(value))}`;

describe("attestation.load freeze + identity stability (CT-1840)", () => {
  it("returns a deep-frozen parse result", () => {
    const id = dataURI({
      value: { name: "Alice", tags: ["a", "b"], nested: { n: 1 } },
    });
    const result = load({ id, type: "application/json" });
    expect(result.ok).toBeDefined();
    expect(isDeepFrozen(result.ok!.value)).toBe(true);
    // Nested containers are frozen too, not just the root.
    const root = result.ok!.value as Record<string, any>;
    expect(Object.isFrozen(root.value)).toBe(true);
    expect(Object.isFrozen(root.value.tags)).toBe(true);
    expect(Object.isFrozen(root.value.nested)).toBe(true);
  });

  it("in-place mutation of a loaded value throws (strict mode)", () => {
    const id = dataURI({ value: { name: "Alice" } });
    const result = load({ id, type: "application/json" });
    const root = result.ok!.value as Record<string, any>;
    expect(() => {
      "use strict";
      root.value.name = "Mallory";
    }).toThrow();
    expect(root.value.name).toBe("Alice");
  });

  it("repeated loads return the SAME result object (identity-stable)", () => {
    const id = dataURI({ value: { repeat: true, n: 42 } });
    const first = load({ id, type: "application/json" });
    const second = load({ id, type: "application/json" });
    expect(second).toBe(first);
    expect(second.ok!.value).toBe(first.ok!.value);
  });

  it("identity survives >1000 distinct interleaved URIs (F4 regression)", () => {
    // The old cache was a 1000-ENTRY LRU: loading >1000 distinct data: URIs
    // cycled it, so re-loading the first URI re-parsed and minted a fresh
    // object identity — silently defeating every identity-keyed cache
    // downstream. The byte-budgeted retention layer keeps all of these
    // (they are tiny), so identity must hold.
    const firstId = dataURI({ value: { marker: "first" } });
    const first = load({ id: firstId, type: "application/json" });
    for (let i = 0; i < 1500; i++) {
      const filler = load({
        id: dataURI({ value: { filler: i } }),
        type: "application/json",
      });
      expect(filler.ok).toBeDefined();
    }
    const again = load({ id: firstId, type: "application/json" });
    expect(again).toBe(first);
    expect(again.ok!.value).toBe(first.ok!.value);
  });

  it("error results are still produced for invalid data URIs", () => {
    const bad = load({
      id: "data:application/json,{not json",
      type: "application/json",
    });
    expect(bad.error).toBeDefined();
    expect(bad.error!.name).toBe("InvalidDataURIError");

    const wrongType = load({
      id: "data:text/plain,hello",
      type: "application/json",
    });
    expect(wrongType.error).toBeDefined();
    expect(wrongType.error!.name).toBe("UnsupportedMediaTypeError");
  });

  it("defaults-injection-style clone leaves the shared cache result intact", () => {
    // schema.ts's defaults-injection arm makes values mutable via
    // cloneIfNecessary({ deep: false, frozen: false, force: false }) before
    // writing default properties. Before the freeze, that call was a no-op
    // for the (unfrozen) shared parse result, so defaults were written INTO
    // the cache. Frozen, the same call must shallow-clone — pin that the
    // cached value is never touched.
    const id = dataURI({ value: { present: 1 } });
    const cached = load({ id, type: "application/json" });
    const root = cached.ok!.value as Record<string, any>;

    const mutable = cloneIfNecessary(root.value as FabricValue, {
      deep: false,
      frozen: false,
      force: false,
    }) as Record<string, any>;
    expect(mutable).not.toBe(root.value);
    mutable.injectedDefault = "should not leak into the cache";

    const reloaded = load({ id, type: "application/json" });
    expect(reloaded).toBe(cached);
    expect(
      (reloaded.ok!.value as Record<string, any>).value.injectedDefault,
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CF_ASSERT_FROZEN_READS: chronicle-level invariant assertion
// ---------------------------------------------------------------------------

class MockReplica implements ISpaceReplica {
  private data = new Map<string, any>();

  constructor(private space: MemorySpace) {}

  did() {
    return this.space;
  }

  get(entry: { id: string; type?: string }) {
    const key = `${entry.id}:${entry.type ?? "application/json"}`;
    return this.data.get(key);
  }

  getDocument() {
    return undefined;
  }

  commit() {
    return Promise.resolve({ ok: {} as any });
  }

  setData(id: string, type: string, value: any) {
    const key = `${id}:${type}`;
    this.data.set(key, { the: type, of: id, is: value });
  }
}

class MockStorageManager implements IStorageManager {
  id = "test-storage";
  replicas = new Map<MemorySpace, MockReplica>();
  as = { did: () => "did:test:user" as const } as unknown as Signer;

  open(space: MemorySpace) {
    let replica = this.replicas.get(space);
    if (!replica) {
      replica = new MockReplica(space);
      this.replicas.set(space, replica);
    }
    return { replica } as any;
  }

  edit() {
    return Transaction.create(this);
  }

  synced() {
    return Promise.resolve();
  }

  addCrossSpacePromise() {}

  removeCrossSpacePromise() {}

  trackUntilSettled() {}

  syncCell<T>(cell: Cell<T>): Promise<Cell<T>> {
    return Promise.resolve(cell);
  }

  subscribe() {}

  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe("CF_ASSERT_FROZEN_READS (CT-1840 invariant assertion)", () => {
  const testSpace: MemorySpace = "did:test:space";

  afterEach(() => {
    setAssertFrozenReadsForTesting(undefined);
  });

  it("passes for data:-URI reads (frozen at parse)", () => {
    setAssertFrozenReadsForTesting(true);
    const storage = new MockStorageManager();
    const tx = storage.edit();

    const result = tx.read({
      space: testSpace,
      id: dataURI({ value: { ok: true } }),
      type: "application/json",
      path: ["value", "ok"],
    });
    expect(result.error).toBeUndefined();
    expect(result.ok?.value).toBe(true);
  });

  it("passes for frozen replica-backed reads", () => {
    setAssertFrozenReadsForTesting(true);
    const storage = new MockStorageManager();
    const replica = storage.open(testSpace).replica as MockReplica;
    replica.setData(
      "doc:frozen",
      "application/json",
      Object.freeze({ value: Object.freeze({ name: "Alice" }) }),
    );

    const tx = storage.edit();
    const result = tx.read({
      space: testSpace,
      id: "doc:frozen",
      type: "application/json",
      path: ["value", "name"],
    });
    expect(result.error).toBeUndefined();
    expect(result.ok?.value).toBe("Alice");
  });

  it("throws for an unfrozen replica-backed read when enabled", () => {
    setAssertFrozenReadsForTesting(true);
    const storage = new MockStorageManager();
    const replica = storage.open(testSpace).replica as MockReplica;
    // Deliberately mutable: simulates a storage path that skipped freezing.
    replica.setData("doc:mutable", "application/json", {
      value: { name: "Alice" },
    });

    const tx = storage.edit();
    expect(() =>
      tx.read({
        space: testSpace,
        id: "doc:mutable",
        type: "application/json",
        path: ["value", "name"],
      })
    ).toThrow(/CF_ASSERT_FROZEN_READS/);
  });

  it("is inert when disabled (default)", () => {
    setAssertFrozenReadsForTesting(false);
    const storage = new MockStorageManager();
    const replica = storage.open(testSpace).replica as MockReplica;
    replica.setData("doc:mutable", "application/json", {
      value: { name: "Alice" },
    });

    const tx = storage.edit();
    const result = tx.read({
      space: testSpace,
      id: "doc:mutable",
      type: "application/json",
      path: ["value", "name"],
    });
    expect(result.error).toBeUndefined();
    expect(result.ok?.value).toBe("Alice");
  });
});
