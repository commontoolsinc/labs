/**
 * Tests for ConsumerTransactResult two-phase commit pattern.
 *
 * Verifies that transact() returns { commit, confirmed } where:
 * - `commit` is available synchronously (local state updated immediately)
 * - `confirmed` is a Promise that resolves on server acknowledgement
 *
 * For local providers, confirmed is already resolved.
 * For simulated remote providers, we test deferred confirmation,
 * stacked commits, and rejection scenarios.
 */

import { assertEquals } from "@std/assert";
import { SpaceV2 } from "../space.ts";
import { ProviderSession } from "../provider.ts";
import { connectLocal, ConsumerSession } from "../consumer.ts";
import type { ConsumerTransactResult, UserOperation } from "../consumer.ts";
import { emptyRef } from "../reference.ts";
import type { Commit } from "../types.ts";

function createSession(): {
  space: SpaceV2;
  provider: ProviderSession;
  consumer: ConsumerSession;
} {
  const space = SpaceV2.open({ url: new URL("memory:test") });
  const provider = new ProviderSession(space);
  const consumer = connectLocal(provider);
  return { space, provider, consumer };
}

// ─── Local Provider: Return Shape ─────────────────────────────────────────────

Deno.test("transact result: returns { commit, confirmed } shape", () => {
  const { consumer } = createSession();

  const result = consumer.transact([
    { op: "set", id: "e1", value: "hello" },
  ]);

  // Shape check
  assertEquals(typeof result, "object");
  assertEquals("commit" in result, true);
  assertEquals("confirmed" in result, true);
  assertEquals(result.commit.version, 1);
  assertEquals(result.confirmed instanceof Promise, true);

  consumer.close();
});

Deno.test("transact result: confirmed resolves to same commit for local provider", async () => {
  const { consumer } = createSession();

  const result = consumer.transact([
    { op: "set", id: "e1", value: "hello" },
  ]);

  const confirmed = await result.confirmed;
  assertEquals(confirmed, result.commit);
  assertEquals(confirmed.version, 1);
  assertEquals(confirmed.facts.length, 1);

  consumer.close();
});

Deno.test("transact result: local state updated synchronously before await", () => {
  const { consumer } = createSession();

  const result = consumer.transact([
    { op: "set", id: "sync-check", value: 42 },
  ]);

  // Before awaiting confirmed, local confirmed state should be updated
  const state = consumer.getConfirmed("sync-check");
  assertEquals(state !== null, true);
  assertEquals(state!.version, result.commit.version);

  consumer.close();
});

// ─── Local Provider: Stacked Commits ──────────────────────────────────────────

Deno.test("transact result: stacked commits all resolve", async () => {
  const { consumer } = createSession();

  const r1 = consumer.transact([{ op: "set", id: "x", value: "v1" }]);
  const r2 = consumer.transact([{ op: "set", id: "x", value: "v2" }]);
  const r3 = consumer.transact([{ op: "set", id: "x", value: "v3" }]);

  assertEquals(r1.commit.version, 1);
  assertEquals(r2.commit.version, 2);
  assertEquals(r3.commit.version, 3);

  // All confirmed promises resolve
  const [c1, c2, c3] = await Promise.all([
    r1.confirmed,
    r2.confirmed,
    r3.confirmed,
  ]);

  assertEquals(c1.version, 1);
  assertEquals(c2.version, 2);
  assertEquals(c3.version, 3);

  consumer.close();
});

Deno.test("transact result: stacked commits on different entities", async () => {
  const { consumer } = createSession();

  const r1 = consumer.transact([{ op: "set", id: "a", value: 1 }]);
  const r2 = consumer.transact([{ op: "set", id: "b", value: 2 }]);
  const r3 = consumer.transact([{ op: "set", id: "c", value: 3 }]);

  // All local commits available immediately
  assertEquals(consumer.getConfirmed("a")!.version, 1);
  assertEquals(consumer.getConfirmed("b")!.version, 2);
  assertEquals(consumer.getConfirmed("c")!.version, 3);

  // All confirmations resolve
  const [c1, c2, c3] = await Promise.all([
    r1.confirmed,
    r2.confirmed,
    r3.confirmed,
  ]);

  assertEquals(c1.facts[0].fact.id, "a");
  assertEquals(c2.facts[0].fact.id, "b");
  assertEquals(c3.facts[0].fact.id, "c");

  consumer.close();
});

Deno.test("transact result: stacked commits with mixed operations", async () => {
  const { consumer } = createSession();

  const r1 = consumer.transact([{ op: "set", id: "m", value: "initial" }]);
  const r2 = consumer.transact([
    {
      op: "patch",
      id: "m",
      patches: [{ op: "replace", path: "", value: "patched" }],
    },
  ]);
  const r3 = consumer.transact([{ op: "delete", id: "m" }]);
  const r4 = consumer.transact([{ op: "set", id: "m", value: "revived" }]);

  assertEquals(r1.commit.version, 1);
  assertEquals(r2.commit.version, 2);
  assertEquals(r3.commit.version, 3);
  assertEquals(r4.commit.version, 4);

  const [c1, _c2, _c3, c4] = await Promise.all([
    r1.confirmed,
    r2.confirmed,
    r3.confirmed,
    r4.confirmed,
  ]);

  assertEquals(c1.version, 1);
  assertEquals(c4.version, 4);

  consumer.close();
});

// ─── Local Provider: Conflict ─────────────────────────────────────────────────

Deno.test("transact result: conflict throws synchronously, no confirmed promise", () => {
  const { consumer, space } = createSession();

  // Write via consumer
  consumer.transact([{ op: "set", id: "x", value: "v1" }]);

  // Concurrent write directly through space (simulating another consumer)
  space.commit({
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: "x",
      value: "v2-other",
      parent: emptyRef("x"),
    }],
  });

  // Consumer's confirmed state is stale — throws synchronously
  let threw = false;
  try {
    consumer.transact([{ op: "set", id: "x", value: "v3" }]);
  } catch (err) {
    threw = true;
    assertEquals((err as Error).name, "ConflictError");
  }
  assertEquals(threw, true);

  consumer.close();
  space.close();
});

// ─── Simulated Deferred Provider ──────────────────────────────────────────────
//
// These tests simulate a remote provider by wrapping a local consumer and
// replacing `confirmed` with a manually-controlled deferred promise.
// This tests the contract that callers should depend on.

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Wraps a local ConsumerSession to simulate deferred (remote) confirmation.
 * The local transact() runs synchronously as usual, but `confirmed` is
 * replaced with a deferred promise that the test controls.
 */
class DeferredConsumer {
  private inner: ConsumerSession;
  pending: Array<
    { result: ConsumerTransactResult; deferred: Deferred<Commit> }
  > = [];

  constructor(inner: ConsumerSession) {
    this.inner = inner;
  }

  transact(
    userOps: UserOperation[],
    options?: { branch?: string },
  ): ConsumerTransactResult {
    // Run the real transact (sync local state update)
    const real = this.inner.transact(userOps, options);

    // Replace confirmed with a deferred promise
    const d = deferred<Commit>();
    this.pending.push({ result: real, deferred: d });

    return { commit: real.commit, confirmed: d.promise };
  }

  /** Confirm the oldest pending commit. */
  confirmNext(): void {
    const entry = this.pending.shift();
    if (!entry) throw new Error("No pending commits to confirm");
    entry.deferred.resolve(entry.result.commit);
  }

  /** Reject the oldest pending commit. */
  rejectNext(reason: string): void {
    const entry = this.pending.shift();
    if (!entry) throw new Error("No pending commits to reject");
    entry.deferred.reject(new Error(reason));
  }

  /** Confirm all pending commits. */
  confirmAll(): void {
    while (this.pending.length > 0) {
      this.confirmNext();
    }
  }

  getConfirmed(entityId: string) {
    return this.inner.getConfirmed(entityId);
  }

  close(): void {
    this.inner.close();
  }
}

function createDeferredSession(): {
  space: SpaceV2;
  consumer: DeferredConsumer;
} {
  const space = SpaceV2.open({ url: new URL("memory:test") });
  const provider = new ProviderSession(space);
  const inner = connectLocal(provider);
  const consumer = new DeferredConsumer(inner);
  return { space, consumer };
}

Deno.test("deferred: local commit available before confirmation", () => {
  const { consumer } = createDeferredSession();

  const result = consumer.transact([{ op: "set", id: "e1", value: "hello" }]);

  // Commit is available synchronously
  assertEquals(result.commit.version, 1);
  assertEquals(result.commit.facts.length, 1);

  // Local state updated synchronously
  assertEquals(consumer.getConfirmed("e1")!.version, 1);

  // But confirmed is still pending
  assertEquals(consumer.pending.length, 1);

  consumer.close();
});

Deno.test("deferred: confirmed resolves after explicit confirmation", async () => {
  const { consumer } = createDeferredSession();

  const result = consumer.transact([{ op: "set", id: "e1", value: "hello" }]);

  // Start listening for confirmation
  let confirmed: Commit | null = null;
  const p = result.confirmed.then((c) => {
    confirmed = c;
  });

  // Not confirmed yet
  assertEquals(confirmed, null);

  // Confirm
  consumer.confirmNext();
  await p;

  assertEquals(confirmed!.version, 1);

  consumer.close();
});

Deno.test("deferred: stacked commits resolve independently", async () => {
  const { consumer } = createDeferredSession();

  const r1 = consumer.transact([{ op: "set", id: "x", value: "v1" }]);
  const r2 = consumer.transact([{ op: "set", id: "x", value: "v2" }]);
  const r3 = consumer.transact([{ op: "set", id: "x", value: "v3" }]);

  // All local commits succeed synchronously
  assertEquals(r1.commit.version, 1);
  assertEquals(r2.commit.version, 2);
  assertEquals(r3.commit.version, 3);

  // Three pending confirmations
  assertEquals(consumer.pending.length, 3);

  // Confirm them one at a time in order
  const results: number[] = [];

  const p1 = r1.confirmed.then((c) => results.push(c.version));
  consumer.confirmNext();
  await p1;
  assertEquals(results, [1]);

  const p2 = r2.confirmed.then((c) => results.push(c.version));
  consumer.confirmNext();
  await p2;
  assertEquals(results, [1, 2]);

  const p3 = r3.confirmed.then((c) => results.push(c.version));
  consumer.confirmNext();
  await p3;
  assertEquals(results, [1, 2, 3]);

  consumer.close();
});

Deno.test("deferred: stacked commits can be confirmed out of order", async () => {
  const { consumer } = createDeferredSession();

  const r1 = consumer.transact([{ op: "set", id: "a", value: 1 }]);
  const r2 = consumer.transact([{ op: "set", id: "b", value: 2 }]);
  const r3 = consumer.transact([{ op: "set", id: "c", value: 3 }]);

  // Confirm in reverse order by resolving deferreds directly
  const results: number[] = [];

  const p3 = r3.confirmed.then((c) => results.push(c.version));
  consumer.pending[2].deferred.resolve(r3.commit);
  await p3;
  assertEquals(results, [3]);

  const p1 = r1.confirmed.then((c) => results.push(c.version));
  consumer.pending[0].deferred.resolve(r1.commit);
  await p1;
  assertEquals(results, [3, 1]);

  // r2 is still pending
  assertEquals(consumer.pending[1].deferred !== undefined, true);

  consumer.pending[1].deferred.resolve(r2.commit);
  const c2 = await r2.confirmed;
  assertEquals(c2.version, 2);

  consumer.close();
});

Deno.test("deferred: rejection does not undo local state", async () => {
  const { consumer, space } = createDeferredSession();

  // Commit 1 succeeds locally
  const r1 = consumer.transact([{ op: "set", id: "x", value: "optimistic" }]);
  assertEquals(r1.commit.version, 1);

  // Local state is updated
  assertEquals(consumer.getConfirmed("x")!.version, 1);
  assertEquals(space.read("x"), "optimistic");

  // Reject the confirmation (simulating server conflict)
  consumer.rejectNext("ServerConflict: version mismatch");

  // Confirmed promise rejects
  let rejected = false;
  try {
    await r1.confirmed;
  } catch (err) {
    rejected = true;
    assertEquals((err as Error).message, "ServerConflict: version mismatch");
  }
  assertEquals(rejected, true);

  // Local state is still there (optimistic) — caller must handle rollback
  assertEquals(consumer.getConfirmed("x")!.version, 1);

  consumer.close();
});

Deno.test("deferred: rejection of middle commit in stack", async () => {
  const { consumer } = createDeferredSession();

  const r1 = consumer.transact([{ op: "set", id: "x", value: "v1" }]);
  const r2 = consumer.transact([{ op: "set", id: "x", value: "v2" }]);
  const r3 = consumer.transact([{ op: "set", id: "x", value: "v3" }]);

  // All succeed locally
  assertEquals(r1.commit.version, 1);
  assertEquals(r2.commit.version, 2);
  assertEquals(r3.commit.version, 3);

  // Confirm r1
  consumer.confirmNext();
  const c1 = await r1.confirmed;
  assertEquals(c1.version, 1);

  // Reject r2
  consumer.rejectNext("ConflictError");
  let r2Rejected = false;
  try {
    await r2.confirmed;
  } catch {
    r2Rejected = true;
  }
  assertEquals(r2Rejected, true);

  // r3 can still be confirmed independently
  consumer.confirmNext();
  const c3 = await r3.confirmed;
  assertEquals(c3.version, 3);

  consumer.close();
});

Deno.test("deferred: Promise.all waits for all confirmations", async () => {
  const { consumer } = createDeferredSession();

  const r1 = consumer.transact([{ op: "set", id: "a", value: 1 }]);
  const r2 = consumer.transact([{ op: "set", id: "b", value: 2 }]);
  const r3 = consumer.transact([{ op: "set", id: "c", value: 3 }]);

  // Confirm all at once
  consumer.confirmAll();

  const [c1, c2, c3] = await Promise.all([
    r1.confirmed,
    r2.confirmed,
    r3.confirmed,
  ]);

  assertEquals(c1.version, 1);
  assertEquals(c2.version, 2);
  assertEquals(c3.version, 3);

  consumer.close();
});

Deno.test("deferred: many stacked commits (50) all confirm", async () => {
  const { consumer } = createDeferredSession();

  const results: ConsumerTransactResult[] = [];
  for (let i = 0; i < 50; i++) {
    results.push(
      consumer.transact([{ op: "set", id: "rapid", value: i }]),
    );
  }

  // All local commits succeeded synchronously
  assertEquals(results[0].commit.version, 1);
  assertEquals(results[49].commit.version, 50);
  assertEquals(consumer.pending.length, 50);

  // Confirm all
  consumer.confirmAll();

  const confirmed = await Promise.all(results.map((r) => r.confirmed));
  assertEquals(confirmed.length, 50);
  for (let i = 0; i < 50; i++) {
    assertEquals(confirmed[i].version, i + 1);
  }

  consumer.close();
});

Deno.test("deferred: interleaved transact and confirm", async () => {
  const { consumer } = createDeferredSession();

  // Transact, confirm, transact, confirm
  const r1 = consumer.transact([{ op: "set", id: "x", value: "v1" }]);
  consumer.confirmNext();
  const c1 = await r1.confirmed;
  assertEquals(c1.version, 1);

  const r2 = consumer.transact([{ op: "set", id: "x", value: "v2" }]);
  consumer.confirmNext();
  const c2 = await r2.confirmed;
  assertEquals(c2.version, 2);

  // Now stack two, confirm both
  const r3 = consumer.transact([{ op: "set", id: "x", value: "v3" }]);
  const r4 = consumer.transact([{ op: "set", id: "x", value: "v4" }]);
  consumer.confirmAll();

  const [c3, c4] = await Promise.all([r3.confirmed, r4.confirmed]);
  assertEquals(c3.version, 3);
  assertEquals(c4.version, 4);

  consumer.close();
});
