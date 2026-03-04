/**
 * Benchmarks for the provider commit path: subscription matching and
 * schema-match logic.
 *
 * Run with:
 *   deno bench --allow-read --allow-write --allow-net --allow-ffi --allow-env --no-check test/provider-commit-bench.ts
 */

import { assert } from "@std/assert";
import type { JSONSchema } from "@commontools/runner";
import * as Changes from "../changes.ts";
import * as Consumer from "../consumer.ts";
import * as Fact from "../fact.ts";
import type { UTCUnixTimestampInSeconds } from "../interface.ts";
import * as Provider from "../provider.ts";
import { refer } from "../reference.ts";
import { space as subject } from "./principal.ts";

const serviceDid = "did:key:z6MkfJPMCrTyDmurrAHPUsEjCgvcjvLtAuzyZ7nSqwZwb8KQ";
const store = new URL(`memory://`);
const the = "application/json";

class Clock {
  private timestamp: UTCUnixTimestampInSeconds;
  constructor() {
    this.timestamp = (Date.now() / 1000) | 0;
  }
  now(): UTCUnixTimestampInSeconds {
    return this.timestamp;
  }
}

let docCounter = 0;
const createDoc = () => `of:${refer({ id: docCounter++ })}` as const;

const ItemSchema = {
  type: "object",
  properties: {
    v: { type: "number" },
    name: { type: "string" },
  },
} as const satisfies JSONSchema;

// --------------------------------------------------------------------------
// Helper: create a provider + consumer with N select subscriptions
// --------------------------------------------------------------------------
async function setupSelectSubscriptions(count: number) {
  const open = await Provider.open({ serviceDid, store });
  assert(open.ok);
  const provider = open.ok;
  const session = provider.session();
  const clock = new Clock();
  const memory = Consumer.open({ as: subject, session, clock }).mount(
    subject.did(),
  );

  // Create docs and subscribe to each
  const docs: ReturnType<typeof createDoc>[] = [];
  // deno-lint-ignore no-explicit-any
  const lastFacts = new Map<string, any>();
  for (let i = 0; i < count; i++) {
    const doc = createDoc();
    docs.push(doc);
    const v = Fact.assert({ the, of: doc, is: { v: i } });
    const tr = await memory.transact({ changes: Changes.from([v]) });
    assert(tr.ok);
    lastFacts.set(doc, v);
    const { ok: query } = await memory.query({
      select: { [doc]: { [the]: {} } },
    });
    assert(query);
    query.subscribe();
  }

  return { provider, memory, docs, lastFacts };
}

// --------------------------------------------------------------------------
// Helper: create a provider + consumer with N selectSchema subscriptions
// --------------------------------------------------------------------------
async function setupSchemaSubscriptions(count: number) {
  const open = await Provider.open({ serviceDid, store });
  assert(open.ok);
  const provider = open.ok;
  const session = provider.session();
  const clock = new Clock();
  const memory = Consumer.open({ as: subject, session, clock }).mount(
    subject.did(),
  );

  // Create docs, then subscribe to each with a schema query
  const docs: ReturnType<typeof createDoc>[] = [];
  // deno-lint-ignore no-explicit-any
  const lastFacts = new Map<string, any>();
  for (let i = 0; i < count; i++) {
    const doc = createDoc();
    docs.push(doc);
    const v = Fact.assert({ the, of: doc, is: { v: i, name: `item-${i}` } });
    const tr = await memory.transact({ changes: Changes.from([v]) });
    assert(tr.ok);
    lastFacts.set(doc, v);
    const { ok: query } = await memory.query({
      selectSchema: {
        [doc]: {
          [the]: {
            _: { path: [], schema: ItemSchema },
          },
        },
      },
    });
    assert(query);
    query.subscribe();
  }

  return { provider, memory, docs, lastFacts };
}

// --------------------------------------------------------------------------
// Benchmark: commit with varying number of select subscriptions
// --------------------------------------------------------------------------
for (const subCount of [1, 10, 50, 100]) {
  Deno.bench({
    name: `commit: 1 doc change, ${subCount} select subscriptions`,
    group: "select-subscriptions",
    baseline: subCount === 1,
    async fn(b) {
      const { provider, memory, docs, lastFacts } =
        await setupSelectSubscriptions(subCount);
      const targetDoc = docs[0];
      let prev = lastFacts.get(targetDoc)!;

      let version = subCount; // continue from setup
      b.start();
      for (let i = 0; i < 10; i++) {
        const v = Fact.assert({
          the,
          of: targetDoc,
          is: { v: ++version },
          cause: prev,
        });
        const tr = await memory.transact({ changes: Changes.from([v]) });
        assert(tr.ok);
        prev = v;
      }
      b.end();

      await provider.close();
    },
  });
}

// --------------------------------------------------------------------------
// Benchmark: commit with varying number of schema subscriptions
// --------------------------------------------------------------------------
for (const subCount of [1, 10, 50, 100]) {
  Deno.bench({
    name: `commit: 1 doc change, ${subCount} schema subscriptions`,
    group: "schema-subscriptions",
    baseline: subCount === 1,
    async fn(b) {
      const { provider, memory, docs, lastFacts } =
        await setupSchemaSubscriptions(subCount);
      const targetDoc = docs[0];
      let prev = lastFacts.get(targetDoc)!;

      let version = subCount;
      b.start();
      for (let i = 0; i < 10; i++) {
        const v = Fact.assert({
          the,
          of: targetDoc,
          is: { v: ++version, name: `updated-${version}` },
          cause: prev,
        });
        const tr = await memory.transact({ changes: Changes.from([v]) });
        assert(tr.ok);
        prev = v;
      }
      b.end();

      await provider.close();
    },
  });
}

// --------------------------------------------------------------------------
// Benchmark: commit with no subscriptions (baseline overhead)
// --------------------------------------------------------------------------
Deno.bench({
  name: "commit: 1 doc change, 0 subscriptions (baseline)",
  group: "select-subscriptions",
  async fn(b) {
    const open = await Provider.open({ serviceDid, store });
    assert(open.ok);
    const provider = open.ok;
    const session = provider.session();
    const clock = new Clock();
    const memory = Consumer.open({ as: subject, session, clock }).mount(
      subject.did(),
    );

    const doc = createDoc();
    let prev = Fact.assert({ the, of: doc, is: { v: 0 } });
    const tr0 = await memory.transact({ changes: Changes.from([prev]) });
    assert(tr0.ok);

    let version = 0;
    b.start();
    for (let i = 0; i < 10; i++) {
      const v = Fact.assert({
        the,
        of: doc,
        is: { v: ++version },
        cause: prev,
      });
      const tr = await memory.transact({ changes: Changes.from([v]) });
      assert(tr.ok);
      prev = v;
    }
    b.end();

    await provider.close();
  },
});

// --------------------------------------------------------------------------
// Benchmark: commit changing an unrelated doc (no subscription match)
// --------------------------------------------------------------------------
for (const subCount of [10, 100]) {
  Deno.bench({
    name: `commit: unrelated doc change, ${subCount} select subscriptions`,
    group: "select-no-match",
    baseline: subCount === 10,
    async fn(b) {
      const { provider, memory } = await setupSelectSubscriptions(subCount);
      const unrelatedDoc = createDoc();

      // Initial fact for the unrelated doc
      let prev = Fact.assert({ the, of: unrelatedDoc, is: { v: 0 } });
      const tr0 = await memory.transact({ changes: Changes.from([prev]) });
      assert(tr0.ok);

      let version = 0;
      b.start();
      for (let i = 0; i < 10; i++) {
        const v = Fact.assert({
          the,
          of: unrelatedDoc,
          is: { v: ++version },
          cause: prev,
        });
        const tr = await memory.transact({ changes: Changes.from([v]) });
        assert(tr.ok);
        prev = v;
      }
      b.end();

      await provider.close();
    },
  });
}
