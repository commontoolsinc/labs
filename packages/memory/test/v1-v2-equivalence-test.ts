/**
 * Memory v1-v2 Equivalence Test
 *
 * Dual-execution test harness that runs identical operations against both
 * v1 (Space) and v2 (SpaceV2 + ConsumerSession + ProviderSession) storage
 * engines and compares observable results.
 *
 * Tests value equivalence, conflict detection, and subscription behavior.
 */

import { assertEquals, assertExists } from "@std/assert";
import { Identity } from "@commontools/identity";
// ─── v1 imports ──────────────────────────────────────────────────────────────
import * as Space from "../space.ts";
import * as Fact from "../fact.ts";
import * as Transaction from "../transaction.ts";
import * as Changes from "../changes.ts";
import type { MIME, StorableDatum, URI } from "../interface.ts";

// ─── v2 imports ──────────────────────────────────────────────────────────────
import { SpaceV2 } from "../v2/space.ts";
import { ProviderSession } from "../v2/provider.ts";
import { connectLocal, type UserOperation } from "../v2/consumer.ts";
import type { ConsumerSession } from "../v2/consumer.ts";
import type { JSONValue, Selector } from "../v2/types.ts";
import type { SubscriptionUpdate } from "../v2/protocol.ts";

// ─── Adapter Interface ───────────────────────────────────────────────────────

/**
 * Common interface for both v1 and v2 storage engines.
 * Normalizes operations to a simple key-value model.
 */
interface StorageAdapter {
  /** Write an entity's value. */
  set(entityId: string, value: JSONValue): void;
  /** Read an entity's current value. Returns null if not found/deleted. */
  get(entityId: string): JSONValue | null;
  /** Delete an entity. */
  delete(entityId: string): void;
  /** Write multiple entities in a single transaction. */
  batch(
    ops: Array<{ id: string; value: JSONValue } | { id: string; delete: true }>,
  ): void;
  /** Subscribe to changes. Returns subscription ID. */
  subscribe(
    entityIds: string[] | "*",
    callback: (entityId: string, value: JSONValue | null) => void,
  ): string;
  /** Unsubscribe. */
  unsubscribe(id: string): void;
  /** Clean up resources. */
  close(): void;
}

// ─── v1 Adapter ──────────────────────────────────────────────────────────────

const THE: MIME = "application/json" as MIME;

class V1Adapter implements StorageAdapter {
  private session: Space.View;
  private issuer: string;
  private subject: string;
  /**
   * Track last fact per entity for cause chaining.
   * After assertion: stores the assertion (has `is`).
   * After retraction: stores the retraction (no `is`, has `cause`).
   * This ensures subsequent writes chain correctly from any prior state.
   */
  // deno-lint-ignore no-explicit-any
  private lastFact = new Map<string, any>();

  private constructor(
    session: Space.View,
    issuer: string,
    subject: string,
  ) {
    this.session = session;
    this.issuer = issuer;
    this.subject = subject;
  }

  static async create(label: string): Promise<V1Adapter> {
    const signer = await Identity.fromPassphrase(`v1-test-${label}`);
    const subject = signer.did();
    const url = new URL(`memory:${subject}`);
    const result = await Space.open({ url });
    assertExists(result.ok, "Failed to open v1 space");
    return new V1Adapter(result.ok, signer.did(), subject);
  }

  /**
   * Compute a proper reference to a fact for cause-chaining.
   * Using Fact.factReference avoids a bug where passing the raw fact to
   * Fact.assert's `cause` drops falsy `is` values (false, 0, null, "").
   */
  private causeRef(fact: unknown) {
    return Fact.factReference(fact as never);
  }

  set(entityId: string, value: JSONValue): void {
    const of = entityId as URI;
    const prevFact = this.lastFact.get(entityId);
    // Use causeRef to properly compute the reference, avoiding the falsy-is bug
    const fact = prevFact
      ? Fact.assert({
        the: THE,
        of,
        is: value as StorableDatum,
        cause: this.causeRef(prevFact),
      })
      : Fact.assert({ the: THE, of, is: value as StorableDatum });

    const tx = Transaction.create({
      issuer: this.issuer as `did:key:${string}`,
      subject: this.subject as `did:key:${string}`,
      changes: Changes.from([fact]),
    });

    const result = Space.transact(this.session, tx);
    if (result.error) {
      throw new Error(
        `v1 set("${entityId}") failed: ${result.error.name}` +
          (result.error.name === "ConflictError"
            ? ` (expected=${
              JSON.stringify(result.error.conflict?.expected)
            }, actual=${JSON.stringify(result.error.conflict?.actual)})`
            : ""),
      );
    }
    this.lastFact.set(entityId, fact);
  }

  get(entityId: string): JSONValue | null {
    const of = entityId as URI;
    const result = Space.query(this.session, {
      cmd: "/memory/query",
      iss: this.issuer as `did:key:${string}`,
      sub: this.subject as `did:key:${string}`,
      args: {
        select: {
          [of]: { [THE]: {} },
        },
      },
      prf: [],
    });

    if (result.error) return null;
    const spaceResult = result.ok?.[this.subject as `did:key:${string}`];
    if (!spaceResult) return null;

    const entityResult = spaceResult[of];
    if (!entityResult) return null;

    const typeResult = entityResult[THE];
    if (!typeResult || typeof typeResult !== "object") return null;

    // Extract value from the cause-keyed structure
    const causes = Object.values(typeResult);
    if (causes.length === 0) return null;

    // Get the latest cause entry (there should be exactly one in the head)
    const entry = causes[0] as { is?: StorableDatum; since: number };
    return entry?.is !== undefined ? (entry.is as JSONValue) : null;
  }

  delete(entityId: string): void {
    const prevFact = this.lastFact.get(entityId);
    if (!prevFact) {
      // Can't retract what doesn't exist
      return;
    }

    const retraction = Fact.retract(prevFact);
    const tx = Transaction.create({
      issuer: this.issuer as `did:key:${string}`,
      subject: this.subject as `did:key:${string}`,
      changes: Changes.from([retraction]),
    });

    const result = Space.transact(this.session, tx);
    if (result.error) {
      throw new Error(`v1 retract failed: ${result.error.name}`);
    }
    // Keep retraction as last fact — subsequent writes chain from it
    this.lastFact.set(entityId, retraction);
  }

  batch(
    ops: Array<{ id: string; value: JSONValue } | { id: string; delete: true }>,
  ): void {
    // Deduplicate: if the same entity appears multiple times, keep only the
    // last operation. v1's single-transaction model requires one fact per
    // entity per cause chain.
    const deduped = new Map<
      string,
      { id: string; value: JSONValue } | { id: string; delete: true }
    >();
    for (const op of ops) {
      deduped.set(op.id, op);
    }

    const statements = [];
    const factUpdates: Array<[string, unknown]> = [];

    for (const op of deduped.values()) {
      const of = op.id as URI;
      if ("delete" in op) {
        const prevFact = this.lastFact.get(op.id);
        if (prevFact) {
          const retraction = Fact.retract(prevFact as never);
          statements.push(retraction);
          factUpdates.push([op.id, retraction]);
        }
      } else {
        const prevFact = this.lastFact.get(op.id);
        const fact = prevFact
          ? Fact.assert({
            the: THE,
            of,
            is: op.value as StorableDatum,
            cause: this.causeRef(prevFact),
          })
          : Fact.assert({ the: THE, of, is: op.value as StorableDatum });
        statements.push(fact);
        factUpdates.push([op.id, fact]);
      }
    }

    if (statements.length === 0) return;

    const tx = Transaction.create({
      issuer: this.issuer as `did:key:${string}`,
      subject: this.subject as `did:key:${string}`,
      changes: Changes.from(statements),
    });

    const result = Space.transact(this.session, tx);
    if (result.error) {
      throw new Error(`v1 batch transact failed: ${result.error.name}`);
    }

    // Only update lastFact after successful commit
    for (const [id, fact] of factUpdates) {
      this.lastFact.set(id, fact);
    }
  }

  subscribe(
    _entityIds: string[] | "*",
    _callback: (entityId: string, value: JSONValue | null) => void,
  ): string {
    // v1 doesn't have subscriptions at the space level.
    // Subscription equivalence is tested through Layer 1 (runner bench wrappers).
    return "v1-no-sub";
  }

  unsubscribe(_id: string): void {
    // No-op for v1
  }

  close(): void {
    Space.close(this.session);
  }
}

// ─── v2 Adapter ──────────────────────────────────────────────────────────────

class V2Adapter implements StorageAdapter {
  private space: SpaceV2;
  private provider: ProviderSession;
  private consumer: ConsumerSession;
  private subscriptionCallbacks = new Map<
    string,
    (entityId: string, value: JSONValue | null) => void
  >();

  private constructor(
    space: SpaceV2,
    provider: ProviderSession,
    consumer: ConsumerSession,
  ) {
    this.space = space;
    this.provider = provider;
    this.consumer = consumer;
  }

  static create(_label: string): V2Adapter {
    const space = SpaceV2.open({ url: new URL("memory:test") });
    const provider = new ProviderSession(space);
    const consumer = connectLocal(provider);
    return new V2Adapter(space, provider, consumer);
  }

  set(entityId: string, value: JSONValue): void {
    this.consumer.transact([
      { op: "set", id: entityId, value },
    ]);
  }

  get(entityId: string): JSONValue | null {
    return this.space.read(entityId);
  }

  delete(entityId: string): void {
    try {
      this.consumer.transact([
        { op: "delete", id: entityId },
      ]);
    } catch {
      // Ignore delete on non-existent entity
    }
  }

  batch(
    ops: Array<{ id: string; value: JSONValue } | { id: string; delete: true }>,
  ): void {
    const userOps: UserOperation[] = ops.map((op) => {
      if ("delete" in op) {
        return { op: "delete" as const, id: op.id };
      }
      return { op: "set" as const, id: op.id, value: op.value };
    });
    this.consumer.transact(userOps);
  }

  subscribe(
    entityIds: string[] | "*",
    callback: (entityId: string, value: JSONValue | null) => void,
  ): string {
    const selector: Selector = {};
    if (entityIds === "*") {
      selector["*"] = {};
    } else {
      for (const id of entityIds) {
        selector[id] = {};
      }
    }

    const { subscriptionId } = this.consumer.subscribe(
      selector,
      (update: SubscriptionUpdate) => {
        const cb = this.subscriptionCallbacks.get(subscriptionId);
        if (!cb) return;
        for (const revision of update.revisions) {
          const entityId = revision.fact.id;
          const value = revision.fact.type === "delete"
            ? null
            : (revision.fact as { value?: JSONValue }).value ?? null;
          cb(entityId, value);
        }
      },
    );

    this.subscriptionCallbacks.set(subscriptionId, callback);
    return subscriptionId;
  }

  unsubscribe(id: string): void {
    this.subscriptionCallbacks.delete(id);
    this.consumer.unsubscribe(id as `job:${string}`);
  }

  close(): void {
    this.consumer.close();
    this.provider.close();
    this.space.close();
  }
}

// ─── Comparison Utilities ────────────────────────────────────────────────────

function compareValues(
  label: string,
  v1Value: JSONValue | null,
  v2Value: JSONValue | null,
): void {
  // Normalize: both null and undefined should be treated as "no value"
  const norm1 = v1Value === undefined ? null : v1Value;
  const norm2 = v2Value === undefined ? null : v2Value;
  assertEquals(
    norm1,
    norm2,
    `Value mismatch for ${label}: v1=${JSON.stringify(norm1)}, v2=${
      JSON.stringify(norm2)
    }`,
  );
}

// ─── Seeded PRNG ─────────────────────────────────────────────────────────────

/** Simple xorshift128+ PRNG with seed support. */
class SeededRng {
  private s0: number;
  private s1: number;

  constructor(seed: number) {
    this.s0 = seed | 0 || 1;
    this.s1 = (seed * 2654435769) | 0 || 1;
  }

  /** Returns a float in [0, 1). */
  next(): number {
    const s0 = this.s0;
    let s1 = this.s1;
    const result = (s0 + s1) | 0;
    s1 ^= s0;
    this.s0 = ((s0 << 24) | (s0 >>> 8)) ^ s1 ^ (s1 << 16);
    this.s1 = (s1 << 37) | (s1 >>> 27);
    return (result >>> 0) / 4294967296;
  }

  /** Returns an integer in [min, max). */
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min)) + min;
  }

  /** Pick a random element from an array. */
  pick<T>(arr: T[]): T {
    return arr[this.int(0, arr.length)];
  }

  /** Shuffle an array in place. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(0, i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

// ─── Value Generators ────────────────────────────────────────────────────────

function randomScalar(rng: SeededRng): JSONValue {
  const kind = rng.int(0, 4);
  switch (kind) {
    case 0:
      return rng.int(-1000, 1000);
    case 1:
      return `str-${rng.int(0, 10000)}`;
    case 2:
      return rng.next() > 0.5;
    case 3:
      return null;
    default:
      return rng.int(0, 100);
  }
}

function randomObject(rng: SeededRng, depth: number = 0): JSONValue {
  if (depth > 3) return randomScalar(rng);

  const kind = rng.int(0, 3);
  if (kind === 0 || depth > 2) {
    return randomScalar(rng);
  }
  if (kind === 1) {
    // Object
    const obj: Record<string, JSONValue> = {};
    const keys = rng.int(1, 6);
    for (let i = 0; i < keys; i++) {
      obj[`k${rng.int(0, 20)}`] = randomObject(rng, depth + 1);
    }
    return obj;
  }
  // Array
  const arr: JSONValue[] = [];
  const len = rng.int(1, 5);
  for (let i = 0; i < len; i++) {
    arr.push(randomObject(rng, depth + 1));
  }
  return arr;
}

// ─── Fixed Scenarios ─────────────────────────────────────────────────────────

Deno.test("equivalence: empty state read", async () => {
  const v1 = await V1Adapter.create("empty-read");
  const v2 = V2Adapter.create("empty-read");

  compareValues("non-existent entity", v1.get("entity:1"), v2.get("entity:1"));

  v1.close();
  v2.close();
});

Deno.test("equivalence: write then read", async () => {
  const v1 = await V1Adapter.create("write-read");
  const v2 = V2Adapter.create("write-read");

  v1.set("entity:1", { name: "Alice", age: 30 });
  v2.set("entity:1", { name: "Alice", age: 30 });

  compareValues("entity:1", v1.get("entity:1"), v2.get("entity:1"));

  v1.close();
  v2.close();
});

Deno.test("equivalence: overwrite", async () => {
  const v1 = await V1Adapter.create("overwrite");
  const v2 = V2Adapter.create("overwrite");

  v1.set("entity:1", { v: 1 });
  v2.set("entity:1", { v: 1 });

  v1.set("entity:1", { v: 2 });
  v2.set("entity:1", { v: 2 });

  compareValues(
    "entity:1 after overwrite",
    v1.get("entity:1"),
    v2.get("entity:1"),
  );

  v1.close();
  v2.close();
});

Deno.test("equivalence: delete then read", async () => {
  const v1 = await V1Adapter.create("delete-read");
  const v2 = V2Adapter.create("delete-read");

  v1.set("entity:1", { v: 1 });
  v2.set("entity:1", { v: 1 });

  v1.delete("entity:1");
  v2.delete("entity:1");

  compareValues(
    "entity:1 after delete",
    v1.get("entity:1"),
    v2.get("entity:1"),
  );

  v1.close();
  v2.close();
});

Deno.test("equivalence: multiple entities", async () => {
  const v1 = await V1Adapter.create("multi-entity");
  const v2 = V2Adapter.create("multi-entity");

  for (let i = 0; i < 10; i++) {
    v1.set(`entity:${i}`, { index: i, data: `value-${i}` });
    v2.set(`entity:${i}`, { index: i, data: `value-${i}` });
  }

  for (let i = 0; i < 10; i++) {
    compareValues(`entity:${i}`, v1.get(`entity:${i}`), v2.get(`entity:${i}`));
  }

  v1.close();
  v2.close();
});

Deno.test("equivalence: batch write", async () => {
  const v1 = await V1Adapter.create("batch");
  const v2 = V2Adapter.create("batch");

  const ops = [
    { id: "a", value: { val: 1 } as JSONValue },
    { id: "b", value: { val: 2 } as JSONValue },
    { id: "c", value: { val: 3 } as JSONValue },
  ];

  v1.batch(ops);
  v2.batch(ops);

  for (const op of ops) {
    compareValues(op.id, v1.get(op.id), v2.get(op.id));
  }

  v1.close();
  v2.close();
});

Deno.test("equivalence: large batch (100 entities)", async () => {
  const v1 = await V1Adapter.create("large-batch");
  const v2 = V2Adapter.create("large-batch");

  const ops = Array.from({ length: 100 }, (_, i) => ({
    id: `e${i}`,
    value: { index: i, data: `payload-${i}` } as JSONValue,
  }));

  v1.batch(ops);
  v2.batch(ops);

  for (const op of ops) {
    compareValues(op.id, v1.get(op.id), v2.get(op.id));
  }

  v1.close();
  v2.close();
});

Deno.test("equivalence: rapid overwrites (100x same entity)", async () => {
  const v1 = await V1Adapter.create("rapid-overwrite");
  const v2 = V2Adapter.create("rapid-overwrite");

  for (let i = 0; i < 100; i++) {
    v1.set("entity:hot", { version: i });
    v2.set("entity:hot", { version: i });
  }

  compareValues(
    "entity:hot after 100 writes",
    v1.get("entity:hot"),
    v2.get("entity:hot"),
  );

  v1.close();
  v2.close();
});

Deno.test("equivalence: mixed set and delete operations", async () => {
  const v1 = await V1Adapter.create("mixed-ops");
  const v2 = V2Adapter.create("mixed-ops");

  // Create entities
  for (let i = 0; i < 10; i++) {
    v1.set(`e${i}`, { v: i });
    v2.set(`e${i}`, { v: i });
  }

  // Delete even-numbered entities
  for (let i = 0; i < 10; i += 2) {
    v1.delete(`e${i}`);
    v2.delete(`e${i}`);
  }

  // Update odd-numbered entities
  for (let i = 1; i < 10; i += 2) {
    v1.set(`e${i}`, { v: i * 10 });
    v2.set(`e${i}`, { v: i * 10 });
  }

  // Compare all
  for (let i = 0; i < 10; i++) {
    compareValues(`e${i}`, v1.get(`e${i}`), v2.get(`e${i}`));
  }

  v1.close();
  v2.close();
});

Deno.test("equivalence: nested objects", async () => {
  const v1 = await V1Adapter.create("nested");
  const v2 = V2Adapter.create("nested");

  const deepValue = {
    level1: {
      level2: {
        level3: {
          array: [1, 2, { nested: true }],
          string: "deep",
        },
      },
      sibling: [null, false, 0, ""],
    },
  };

  v1.set("deep", deepValue);
  v2.set("deep", deepValue);

  compareValues("deep nested value", v1.get("deep"), v2.get("deep"));

  v1.close();
  v2.close();
});

Deno.test("equivalence: null and edge-case values", async () => {
  const v1 = await V1Adapter.create("edge-values");
  const v2 = V2Adapter.create("edge-values");

  const edgeCases: [string, JSONValue][] = [
    ["null-val", null],
    ["zero", 0],
    ["empty-string", ""],
    ["false-val", false],
    ["empty-obj", {}],
    ["empty-arr", []],
    ["nested-null", { a: null, b: [null] }],
  ];

  for (const [id, val] of edgeCases) {
    v1.set(id, val);
    v2.set(id, val);
  }

  for (const [id] of edgeCases) {
    compareValues(id, v1.get(id), v2.get(id));
  }

  v1.close();
  v2.close();
});

Deno.test("equivalence: entity references (cross-entity links)", async () => {
  const v1 = await V1Adapter.create("cross-refs");
  const v2 = V2Adapter.create("cross-refs");

  // Entity A references B, B references C
  v1.set("entity:c", { name: "C", value: 42 });
  v2.set("entity:c", { name: "C", value: 42 });

  v1.set("entity:b", { name: "B", ref: { "/": "entity:c" } });
  v2.set("entity:b", { name: "B", ref: { "/": "entity:c" } });

  v1.set("entity:a", { name: "A", ref: { "/": "entity:b" } });
  v2.set("entity:a", { name: "A", ref: { "/": "entity:b" } });

  // Values are stored as-is (link following is a runner concern)
  compareValues("entity:a", v1.get("entity:a"), v2.get("entity:a"));
  compareValues("entity:b", v1.get("entity:b"), v2.get("entity:b"));
  compareValues("entity:c", v1.get("entity:c"), v2.get("entity:c"));

  // Update target
  v1.set("entity:c", { name: "C", value: 99 });
  v2.set("entity:c", { name: "C", value: 99 });

  compareValues(
    "entity:c after update",
    v1.get("entity:c"),
    v2.get("entity:c"),
  );

  // Retarget link
  v1.set("entity:a", { name: "A", ref: { "/": "entity:c" } });
  v2.set("entity:a", { name: "A", ref: { "/": "entity:c" } });

  compareValues(
    "entity:a after retarget",
    v1.get("entity:a"),
    v2.get("entity:a"),
  );

  v1.close();
  v2.close();
});

Deno.test("equivalence: array of links", async () => {
  const v1 = await V1Adapter.create("array-links");
  const v2 = V2Adapter.create("array-links");

  // Create targets
  for (let i = 0; i < 5; i++) {
    v1.set(`target:${i}`, { index: i });
    v2.set(`target:${i}`, { index: i });
  }

  // Create entity with array of references
  const refs = Array.from({ length: 5 }, (_, i) => ({ "/": `target:${i}` }));
  v1.set("collection", { items: refs });
  v2.set("collection", { items: refs });

  compareValues(
    "collection with refs",
    v1.get("collection"),
    v2.get("collection"),
  );

  v1.close();
  v2.close();
});

Deno.test("equivalence: v2 subscription fires on write", () => {
  const v2 = V2Adapter.create("sub-write");

  const notifications: Array<{ entityId: string; value: JSONValue | null }> =
    [];
  const subId = v2.subscribe(["entity:1"], (entityId, value) => {
    notifications.push({ entityId, value });
  });

  v2.set("entity:1", { first: true });
  assertEquals(notifications.length, 1, "Should receive 1 notification");
  assertEquals(notifications[0].entityId, "entity:1");
  assertEquals(notifications[0].value, { first: true });

  v2.set("entity:1", { second: true });
  assertEquals(notifications.length, 2, "Should receive 2 notifications");

  v2.unsubscribe(subId);
  v2.close();
});

Deno.test("equivalence: v2 subscription fires on delete", () => {
  const v2 = V2Adapter.create("sub-delete");

  v2.set("entity:1", { alive: true });

  const notifications: Array<{ entityId: string; value: JSONValue | null }> =
    [];
  const subId = v2.subscribe(["entity:1"], (entityId, value) => {
    notifications.push({ entityId, value });
  });

  v2.delete("entity:1");
  assertEquals(notifications.length, 1, "Should receive delete notification");
  assertEquals(notifications[0].value, null);

  v2.unsubscribe(subId);
  v2.close();
});

Deno.test("equivalence: v2 wildcard subscription", () => {
  const v2 = V2Adapter.create("sub-wildcard");

  const seen = new Set<string>();
  const subId = v2.subscribe("*", (entityId) => {
    seen.add(entityId);
  });

  v2.set("a", 1);
  v2.set("b", 2);
  v2.set("c", 3);

  assertEquals(seen.size, 3, "Wildcard should capture all entities");
  assertEquals(seen.has("a"), true);
  assertEquals(seen.has("b"), true);
  assertEquals(seen.has("c"), true);

  v2.unsubscribe(subId);
  v2.close();
});

Deno.test("equivalence: v2 subscription churn", () => {
  const v2 = V2Adapter.create("sub-churn");

  let count = 0;
  const subId = v2.subscribe(["entity:1"], () => {
    count++;
  });

  // 5 updates while subscribed
  for (let i = 0; i < 5; i++) {
    v2.set("entity:1", { v: i });
  }
  assertEquals(count, 5, "Should get 5 notifications while subscribed");

  // Unsubscribe
  v2.unsubscribe(subId);

  // 5 more updates (should not fire)
  for (let i = 5; i < 10; i++) {
    v2.set("entity:1", { v: i });
  }
  assertEquals(count, 5, "Should still be 5 after unsubscribe");

  // Re-subscribe
  let count2 = 0;
  const subId2 = v2.subscribe(["entity:1"], () => {
    count2++;
  });

  v2.set("entity:1", { v: 99 });
  assertEquals(count2, 1, "Re-subscription should fire");

  v2.unsubscribe(subId2);
  v2.close();
});

// ─── Random Workload Generator ───────────────────────────────────────────────

interface WorkloadResult {
  /** Entities written (for comparison). */
  entities: string[];
  /** Number of operations executed. */
  opCount: number;
}

function runWorkload(
  adapter: StorageAdapter,
  rng: SeededRng,
  numOps: number,
): WorkloadResult {
  const entities = new Set<string>();
  const alive = new Set<string>(); // entities that exist (not deleted)
  let opCount = 0;

  for (let i = 0; i < numOps; i++) {
    const roll = rng.next();
    const entityId = `e${rng.int(0, 50)}`;
    entities.add(entityId);

    if (roll < 0.4) {
      // Set with random value (40%)
      const value = randomObject(rng);
      adapter.set(entityId, value);
      alive.add(entityId);
    } else if (roll < 0.55 && alive.has(entityId)) {
      // Overwrite existing entity (15%)
      const value = randomObject(rng);
      adapter.set(entityId, value);
    } else if (roll < 0.65 && alive.has(entityId)) {
      // Delete (10%)
      adapter.delete(entityId);
      alive.delete(entityId);
    } else if (roll < 0.80) {
      // Batch write (15%) — deduplicate entity IDs
      const batchSize = rng.int(1, 6);
      const batchMap = new Map<string, JSONValue>();
      for (let j = 0; j < batchSize; j++) {
        const batchEntity = `e${rng.int(0, 50)}`;
        entities.add(batchEntity);
        batchMap.set(batchEntity, randomObject(rng));
        alive.add(batchEntity);
      }
      const ops = [...batchMap.entries()].map(([id, value]) => ({ id, value }));
      adapter.batch(ops);
    } else {
      // Set with nested/complex value (20%)
      const value = randomObject(rng, 0);
      adapter.set(entityId, value);
      alive.add(entityId);
    }
    opCount++;
  }

  return { entities: [...entities], opCount };
}

function runEquivalenceTest(seed: number, numOps: number) {
  return async () => {
    // Create two RNGs with the same seed — same operation sequence
    const rng1 = new SeededRng(seed);
    const rng2 = new SeededRng(seed);

    const v1 = await V1Adapter.create(`random-${seed}`);
    const v2 = V2Adapter.create(`random-${seed}`);

    const result1 = runWorkload(v1, rng1, numOps);
    const result2 = runWorkload(v2, rng2, numOps);

    assertEquals(
      result1.opCount,
      result2.opCount,
      "Operation counts should match",
    );

    // Compare all entity values
    const allEntities = new Set([...result1.entities, ...result2.entities]);
    let mismatches = 0;
    for (const entityId of allEntities) {
      const v1Val = v1.get(entityId);
      const v2Val = v2.get(entityId);
      try {
        compareValues(entityId, v1Val, v2Val);
      } catch (_err) {
        mismatches++;
        if (mismatches <= 5) {
          console.error(
            `  Mismatch[seed=${seed}] ${entityId}: v1=${
              JSON.stringify(v1Val)
            } v2=${JSON.stringify(v2Val)}`,
          );
        }
      }
    }

    assertEquals(
      mismatches,
      0,
      `${mismatches} entity value mismatches (seed=${seed}, ops=${numOps})`,
    );

    v1.close();
    v2.close();
  };
}

// Run with 5 different seeds, 200 ops each
for (const seed of [42, 123, 7777, 31415, 99999]) {
  Deno.test(
    `equivalence: random workload (seed=${seed}, 200 ops)`,
    runEquivalenceTest(seed, 200),
  );
}

// Larger stress test
Deno.test(
  "equivalence: stress test (seed=12345, 1000 ops)",
  runEquivalenceTest(12345, 1000),
);
