/**
 * Memory v2 Session Integration Tests
 *
 * Tests the consumer-provider interaction using connectLocal().
 * Exercises transact, query, subscribe, unsubscribe, and branch commands.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { SpaceV2 } from "../space.ts";
import { ProviderSession } from "../provider.ts";
import { connectLocal } from "../consumer.ts";
import type { ConsumerSession, UserOperation } from "../consumer.ts";
import { emptyRef } from "../reference.ts";
import type { Selector } from "../types.ts";
import type { SubscriptionUpdate } from "../protocol.ts";

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

// ─── Transact ────────────────────────────────────────────────────────────────

Deno.test("session - transact: write and read back", () => {
  const { consumer, space } = createSession();

  const ops: UserOperation[] = [
    { op: "set", id: "entity-1", value: { name: "Alice" } },
  ];

  const { commit } = consumer.transact(ops);
  assertEquals(commit.version, 1);
  assertEquals(commit.facts.length, 1);
  assertEquals(commit.facts[0].fact.id, "entity-1");

  // Verify value was stored
  const value = space.read("entity-1");
  assertEquals(value, { name: "Alice" });

  consumer.close();
  space.close();
});

Deno.test("session - transact: multiple entities", () => {
  const { consumer, space } = createSession();

  const ops: UserOperation[] = [
    { op: "set", id: "a", value: 1 },
    { op: "set", id: "b", value: 2 },
    { op: "set", id: "c", value: 3 },
  ];

  const { commit } = consumer.transact(ops);
  assertEquals(commit.version, 1);
  assertEquals(commit.facts.length, 3);

  assertEquals(space.read("a"), 1);
  assertEquals(space.read("b"), 2);
  assertEquals(space.read("c"), 3);

  consumer.close();
  space.close();
});

Deno.test("session - transact: sequential commits", () => {
  const { consumer, space } = createSession();

  const { commit: c1 } = consumer.transact([
    { op: "set", id: "x", value: "first" },
  ]);
  assertEquals(c1.version, 1);

  const { commit: c2 } = consumer.transact([
    { op: "set", id: "x", value: "second" },
  ]);
  assertEquals(c2.version, 2);

  assertEquals(space.read("x"), "second");

  consumer.close();
  space.close();
});

Deno.test("session - transact: conflict detection with stale confirmed state", () => {
  const { consumer, space } = createSession();

  // Consumer writes entity "x"
  consumer.transact([{ op: "set", id: "x", value: "v1" }]);

  // Another writer modifies "x" directly through the space
  // (simulating a concurrent write from another consumer)
  space.commit({
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: "x",
      value: "v2-other",
      parent: emptyRef("x"),
    }],
  });

  // Consumer's confirmed state is now stale (version 1, but head is version 2)
  // Next transact on "x" should conflict because consumer sends stale read
  assertThrows(
    () => consumer.transact([{ op: "set", id: "x", value: "v3" }]),
    Error,
    "ConflictError",
  );

  consumer.close();
  space.close();
});

Deno.test("session - transact: delete operation", () => {
  const { consumer, space } = createSession();

  consumer.transact([{ op: "set", id: "d", value: "exists" }]);
  assertEquals(space.read("d"), "exists");

  consumer.transact([{ op: "delete", id: "d" }]);
  assertEquals(space.read("d"), null);

  consumer.close();
  space.close();
});

Deno.test("session - transact: patch operation", () => {
  const { consumer, space } = createSession();

  consumer.transact([
    { op: "set", id: "p", value: { a: 1, b: 2 } },
  ]);

  consumer.transact([
    {
      op: "patch",
      id: "p",
      patches: [{ op: "replace", path: "/a", value: 10 }],
    },
  ]);

  assertEquals(space.read("p"), { a: 10, b: 2 });

  consumer.close();
  space.close();
});

// ─── Query ───────────────────────────────────────────────────────────────────

Deno.test("session - query: specific entity", () => {
  const { consumer } = createSession();

  consumer.transact([
    { op: "set", id: "q1", value: "hello" },
    { op: "set", id: "q2", value: "world" },
  ]);

  const result = consumer.query({ q1: {} } as Selector);
  assertEquals(Object.keys(result).length, 1);
  assertEquals(result["q1"].value, "hello");

  consumer.close();
});

Deno.test("session - query: wildcard", () => {
  const { consumer } = createSession();

  consumer.transact([
    { op: "set", id: "w1", value: 1 },
    { op: "set", id: "w2", value: 2 },
  ]);

  const result = consumer.query({ "*": {} } as Selector);
  assertEquals(Object.keys(result).length, 2);
  assertEquals(result["w1"].value, 1);
  assertEquals(result["w2"].value, 2);

  consumer.close();
});

Deno.test("session - query: since filter", () => {
  const { consumer } = createSession();

  consumer.transact([{ op: "set", id: "s1", value: "v1" }]);
  consumer.transact([{ op: "set", id: "s2", value: "v2" }]);

  // Query with since=1 should only return changes after version 1
  const result = consumer.query({ "*": {} } as Selector, { since: 1 });
  assertEquals(Object.keys(result).length, 1);
  assertEquals(result["s2"].value, "v2");

  consumer.close();
});

Deno.test("session - query: non-existent entity returns empty", () => {
  const { consumer } = createSession();

  const result = consumer.query({ "no-such-entity": {} } as Selector);
  assertEquals(Object.keys(result).length, 0);

  consumer.close();
});

Deno.test("session - query: updates confirmed state", () => {
  const { consumer } = createSession();

  consumer.transact([{ op: "set", id: "c1", value: "initial" }]);

  // Query should populate confirmed state
  consumer.query({ c1: {} } as Selector);

  const confirmed = consumer.getConfirmed("c1");
  assertEquals(confirmed !== null, true);
  assertEquals(confirmed!.version, 1);

  consumer.close();
});

// ─── Subscribe ───────────────────────────────────────────────────────────────

Deno.test("session - subscribe: receives initial state", () => {
  const { consumer } = createSession();

  consumer.transact([{ op: "set", id: "sub1", value: "initial" }]);

  const updates: SubscriptionUpdate[] = [];
  const { facts, subscriptionId } = consumer.subscribe(
    { sub1: {} } as Selector,
    (update) => updates.push(update),
  );

  assertEquals(Object.keys(facts).length, 1);
  assertEquals(facts["sub1"].value, "initial");
  assertEquals(typeof subscriptionId, "string");

  consumer.close();
});

Deno.test("session - subscribe: receives updates on write", () => {
  const { consumer } = createSession();

  consumer.transact([{ op: "set", id: "live", value: "v1" }]);

  const updates: SubscriptionUpdate[] = [];
  consumer.subscribe(
    { live: {} } as Selector,
    (update) => updates.push(update),
  );

  // Write to the subscribed entity
  consumer.transact([{ op: "set", id: "live", value: "v2" }]);

  assertEquals(updates.length, 1);
  assertEquals(updates[0].commit.version, 2);
  assertEquals(updates[0].revisions.length, 1);
  assertEquals(updates[0].revisions[0].fact.id, "live");

  consumer.close();
});

Deno.test("session - subscribe: receives multiple updates", () => {
  const { consumer } = createSession();

  const updates: SubscriptionUpdate[] = [];
  consumer.subscribe(
    { multi: {} } as Selector,
    (update) => updates.push(update),
  );

  consumer.transact([{ op: "set", id: "multi", value: "v1" }]);
  consumer.transact([{ op: "set", id: "multi", value: "v2" }]);
  consumer.transact([{ op: "set", id: "multi", value: "v3" }]);

  assertEquals(updates.length, 3);
  assertEquals(updates[0].commit.version, 1);
  assertEquals(updates[1].commit.version, 2);
  assertEquals(updates[2].commit.version, 3);

  consumer.close();
});

Deno.test("session - subscribe: wildcard receives all writes", () => {
  const { consumer } = createSession();

  const updates: SubscriptionUpdate[] = [];
  consumer.subscribe(
    { "*": {} } as Selector,
    (update) => updates.push(update),
  );

  consumer.transact([{ op: "set", id: "a", value: 1 }]);
  consumer.transact([{ op: "set", id: "b", value: 2 }]);

  assertEquals(updates.length, 2);

  consumer.close();
});

Deno.test("session - subscribe: does not receive unrelated writes", () => {
  const { consumer } = createSession();

  const updates: SubscriptionUpdate[] = [];
  consumer.subscribe(
    { "watched": {} } as Selector,
    (update) => updates.push(update),
  );

  // Write to a different entity
  consumer.transact([{ op: "set", id: "unwatched", value: "ignored" }]);

  assertEquals(updates.length, 0);

  consumer.close();
});

Deno.test("session - subscribe: delete triggers notification", () => {
  const { consumer } = createSession();

  consumer.transact([{ op: "set", id: "del", value: "exists" }]);

  const updates: SubscriptionUpdate[] = [];
  consumer.subscribe(
    { del: {} } as Selector,
    (update) => updates.push(update),
  );

  consumer.transact([{ op: "delete", id: "del" }]);

  assertEquals(updates.length, 1);
  assertEquals(updates[0].revisions[0].fact.id, "del");

  consumer.close();
});

// ─── Unsubscribe ─────────────────────────────────────────────────────────────

Deno.test("session - unsubscribe: stops receiving updates", () => {
  const { consumer } = createSession();

  const updates: SubscriptionUpdate[] = [];
  const { subscriptionId } = consumer.subscribe(
    { "unsub-test": {} } as Selector,
    (update) => updates.push(update),
  );

  consumer.transact([{ op: "set", id: "unsub-test", value: "v1" }]);
  assertEquals(updates.length, 1);

  // Unsubscribe
  consumer.unsubscribe(subscriptionId);

  // Further writes should not trigger updates
  consumer.transact([{ op: "set", id: "unsub-test", value: "v2" }]);
  assertEquals(updates.length, 1); // Still 1

  consumer.close();
});

// ─── Branches ────────────────────────────────────────────────────────────────

Deno.test("session - branch: create and write to branch", () => {
  const { consumer, space } = createSession();

  // Write to default branch
  consumer.transact([{ op: "set", id: "shared", value: "main" }]);

  // Create a branch (use provider directly since consumer doesn't have branch commands yet)
  space.createBranch("feature");

  // Write to branch
  consumer.transact(
    [{ op: "set", id: "shared", value: "feature-value" }],
    { branch: "feature" },
  );

  // Default branch should be unchanged
  assertEquals(space.read("shared"), "main");
  assertEquals(space.read("shared", "feature"), "feature-value");

  consumer.close();
  space.close();
});

Deno.test("session - branch: query on branch", () => {
  const { consumer, space } = createSession();

  consumer.transact([{ op: "set", id: "br-q", value: "default" }]);
  space.createBranch("dev");
  consumer.transact(
    [{ op: "set", id: "br-q", value: "dev-value" }],
    { branch: "dev" },
  );

  const defaultResult = consumer.query({ "br-q": {} } as Selector);
  assertEquals(defaultResult["br-q"].value, "default");

  const devResult = consumer.query(
    { "br-q": {} } as Selector,
    { branch: "dev" },
  );
  assertEquals(devResult["br-q"].value, "dev-value");

  consumer.close();
  space.close();
});

Deno.test("session - branch: subscription scoped to branch", () => {
  const { consumer, space } = createSession();

  space.createBranch("isolated");

  const defaultUpdates: SubscriptionUpdate[] = [];
  const branchUpdates: SubscriptionUpdate[] = [];

  consumer.subscribe(
    { "br-sub": {} } as Selector,
    (update) => defaultUpdates.push(update),
  );

  consumer.subscribe(
    { "br-sub": {} } as Selector,
    (update) => branchUpdates.push(update),
    { branch: "isolated" },
  );

  // Write to default branch — only default subscription fires
  consumer.transact([{ op: "set", id: "br-sub", value: "default" }]);
  assertEquals(defaultUpdates.length, 1);
  assertEquals(branchUpdates.length, 0);

  // Write to "isolated" branch — only branch subscription fires
  consumer.transact(
    [{ op: "set", id: "br-sub", value: "isolated" }],
    { branch: "isolated" },
  );
  assertEquals(defaultUpdates.length, 1);
  assertEquals(branchUpdates.length, 1);

  consumer.close();
  space.close();
});

// ─── Confirmed State ─────────────────────────────────────────────────────────

Deno.test("session - confirmed: tracks state after transact", () => {
  const { consumer } = createSession();

  consumer.transact([{ op: "set", id: "conf", value: "hello" }]);

  const confirmed = consumer.getConfirmed("conf");
  assertEquals(confirmed !== null, true);
  assertEquals(confirmed!.version, 1);
  assertEquals(confirmed!.hash != null, true);

  consumer.close();
});

Deno.test("session - confirmed: updated on sequential writes", () => {
  const { consumer } = createSession();

  consumer.transact([{ op: "set", id: "seq", value: "v1" }]);
  const c1 = consumer.getConfirmed("seq");
  assertEquals(c1!.version, 1);

  consumer.transact([{ op: "set", id: "seq", value: "v2" }]);
  const c2 = consumer.getConfirmed("seq");
  assertEquals(c2!.version, 2);

  consumer.close();
});

Deno.test("session - confirmed: returns null for unknown entity", () => {
  const { consumer } = createSession();

  const confirmed = consumer.getConfirmed("nope");
  assertEquals(confirmed, null);

  consumer.close();
});

// ─── Close ───────────────────────────────────────────────────────────────────

Deno.test("session - close: cleans up subscriptions", () => {
  const { consumer, provider } = createSession();

  const updates: SubscriptionUpdate[] = [];
  consumer.subscribe(
    { "cleanup": {} } as Selector,
    (update) => updates.push(update),
  );

  // Close consumer — should clean up effect listener
  consumer.close();

  // Provider still works but consumer shouldn't receive updates
  // (The provider's subscription still exists but the consumer's
  // effect listener is gone, so no callback fires)
  provider.invoke("job:direct" as `job:${string}`, {
    cmd: "/memory/transact",
    sub: "did:key:test" as `did:${string}`,
    args: {
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "cleanup",
        value: "after-close",
        parent: emptyRef("cleanup"),
      }],
    },
  });

  assertEquals(updates.length, 0);

  provider.close();
});

// ─── Subscription Matching ───────────────────────────────────────────────────

Deno.test("session - subscription: multi-entity commit fires once", () => {
  const { consumer } = createSession();

  const updates: SubscriptionUpdate[] = [];
  consumer.subscribe(
    { "*": {} } as Selector,
    (update) => updates.push(update),
  );

  // Single commit with multiple entities
  consumer.transact([
    { op: "set", id: "m1", value: 1 },
    { op: "set", id: "m2", value: 2 },
    { op: "set", id: "m3", value: 3 },
  ]);

  // Should get one update (one commit) with all matching revisions
  assertEquals(updates.length, 1);
  assertEquals(updates[0].revisions.length, 3);

  consumer.close();
});

Deno.test("session - subscription: selective matching in multi-entity commit", () => {
  const { consumer } = createSession();

  const updates: SubscriptionUpdate[] = [];
  consumer.subscribe(
    { "target": {} } as Selector,
    (update) => updates.push(update),
  );

  // Commit with both watched and unwatched entities
  consumer.transact([
    { op: "set", id: "target", value: "hit" },
    { op: "set", id: "other", value: "miss" },
  ]);

  assertEquals(updates.length, 1);
  assertEquals(updates[0].revisions.length, 1);
  assertEquals(updates[0].revisions[0].fact.id, "target");

  consumer.close();
});

// ─── Rapid Operations ────────────────────────────────────────────────────────

Deno.test("session - rapid: 50 sequential writes with subscription", () => {
  const { consumer } = createSession();

  const updates: SubscriptionUpdate[] = [];
  consumer.subscribe(
    { rapid: {} } as Selector,
    (update) => updates.push(update),
  );

  for (let i = 0; i < 50; i++) {
    consumer.transact([{ op: "set", id: "rapid", value: i }]);
  }

  assertEquals(updates.length, 50);

  // Verify versions are sequential
  for (let i = 0; i < 50; i++) {
    assertEquals(updates[i].commit.version, i + 1);
  }

  consumer.close();
});

Deno.test("session - rapid: subscribe-unsubscribe-resubscribe", () => {
  const { consumer } = createSession();

  const updates1: SubscriptionUpdate[] = [];
  const { subscriptionId: sub1 } = consumer.subscribe(
    { churn: {} } as Selector,
    (update) => updates1.push(update),
  );

  consumer.transact([{ op: "set", id: "churn", value: "v1" }]);
  consumer.transact([{ op: "set", id: "churn", value: "v2" }]);
  assertEquals(updates1.length, 2);

  consumer.unsubscribe(sub1);

  consumer.transact([{ op: "set", id: "churn", value: "v3" }]);
  assertEquals(updates1.length, 2); // No new updates

  const updates2: SubscriptionUpdate[] = [];
  consumer.subscribe(
    { churn: {} } as Selector,
    (update) => updates2.push(update),
  );

  consumer.transact([{ op: "set", id: "churn", value: "v4" }]);
  assertEquals(updates2.length, 1);
  assertEquals(updates1.length, 2); // Still 2

  consumer.close();
});
