/**
 * Tests for redactCommitData call sites.
 *
 * These tests verify that the `labels` property is properly stripped from
 * CommitData at each call site:
 * - provider.ts: When commits are broadcast to subscribers
 * - space-schema.ts: When commit log data is included in query results
 */
import { assert, assertEquals, assertFalse } from "@std/assert";
import { refer } from "../reference.ts";
import * as Changes from "../changes.ts";
import * as Commit from "../commit.ts";
import * as Consumer from "../consumer.ts";
import * as Fact from "../fact.ts";
import type { UTCUnixTimestampInSeconds } from "../interface.ts";
import * as Provider from "../provider.ts";
import { LABEL_TYPE } from "../space.ts";
import { alice } from "./principal.ts";

const serviceDid = "did:key:z6MkfJPMCrTyDmurrAHPUsEjCgvcjvLtAuzyZ7nSqwZwb8KQ";

class Clock {
  private timestamp: UTCUnixTimestampInSeconds;
  constructor() {
    this.timestamp = (Date.now() / 1000) | 0;
  }
  now(): UTCUnixTimestampInSeconds {
    return this.timestamp;
  }
}

const doc = `of:${refer({ test: "redact-call-sites" })}` as const;
const the = "application/json";
const store = new URL(`memory://`);

const test = (
  title: string,
  url: URL,
  run: (
    session: Provider.ProviderSession<Provider.Protocol>,
    provider: Provider.Provider<Provider.Protocol>,
  ) => Promise<unknown>,
) => {
  const unit = async () => {
    const open = await Provider.open({
      serviceDid,
      store: url,
    });

    assert(open.ok, "Open create repository if it does not exist");
    const provider = open.ok;
    const session = provider.session();

    try {
      await run(session, provider);
    } finally {
      await provider.close();
    }
  };

  if (title.startsWith("only")) {
    Deno.test.only(title, unit);
  } else if (title.startsWith("skip")) {
    Deno.test.ignore(title, unit);
  } else {
    Deno.test(title, unit);
  }
};

// =============================================================================
// Provider call site tests (provider.ts:464)
// =============================================================================

test(
  "provider subscription - commit data has no labels property",
  store,
  async (session) => {
    const clock = new Clock();
    const memory = Consumer.open({ as: alice, session, clock }).mount(
      alice.did(),
    );

    // Create initial fact to establish doc
    const v1 = Fact.assert({
      the,
      of: doc,
      is: { v: 1 },
    });
    const r1 = await memory.transact({ changes: Changes.from([v1]) });
    assert(r1.ok);

    // Subscribe to commits
    const query = memory.query({
      select: {
        [alice.did()]: {
          "application/commit+json": {
            _: {},
          },
        },
      },
    });
    const subscription = query.subscribe();
    const reader = subscription.getReader();
    const pendingRead = reader.read();

    // Create a fact with a label (classification)
    const v2 = Fact.assert({
      the,
      of: doc,
      is: { v: 2 },
      cause: v1,
    });
    const v2_label = Fact.assert({
      the: LABEL_TYPE,
      of: doc,
      is: { classification: ["confidential"] },
    });

    const r2 = await memory.transact({
      changes: Changes.from([v2, v2_label]),
    });
    assert(r2.ok);
    const c2 = Commit.toRevision(r2.ok);

    // Read the commit from subscription
    const result = await pendingRead;
    assertFalse(result.done);

    // Get the commit data from the subscription result
    // deno-lint-ignore no-explicit-any
    const commit = result.value.commit as any;
    const commitEntry = commit[alice.did()]?.["application/commit+json"]?.[
      c2.cause.toString()
    ];
    assert(commitEntry, "commit entry should exist");

    // The key assertion: labels should NOT be present
    assertEquals(
      "labels" in commitEntry.is,
      false,
      "labels property should be stripped from commit data in subscription",
    );

    reader.cancel();
  },
);

test(
  "provider subscription - labels stripped even when content has labels",
  store,
  async (session) => {
    const clock = new Clock();
    const memory = Consumer.open({ as: alice, session, clock }).mount(
      alice.did(),
    );

    // Create initial fact
    const v1 = Fact.assert({
      the,
      of: doc,
      is: { v: 1 },
    });
    const r1 = await memory.transact({ changes: Changes.from([v1]) });
    assert(r1.ok);

    // Subscribe to commits
    const query = memory.query({
      select: {
        [alice.did()]: {
          "application/commit+json": {
            _: {},
          },
        },
      },
    });
    const subscription = query.subscribe();
    const reader = subscription.getReader();
    const pendingRead = reader.read();

    // Create content WITH a label
    const v2 = Fact.assert({
      the,
      of: doc,
      is: { v: 2 },
      cause: v1,
    });
    const v2_label = Fact.assert({
      the: LABEL_TYPE,
      of: doc,
      is: { classification: ["confidential"] },
    });

    const r2 = await memory.transact({
      changes: Changes.from([v2, v2_label]),
    });
    assert(r2.ok);
    const c2 = Commit.toRevision(r2.ok);

    const result = await pendingRead;
    assertFalse(result.done);

    // deno-lint-ignore no-explicit-any
    const commit = result.value.commit as any;
    const commitEntry = commit[alice.did()]?.["application/commit+json"]?.[
      c2.cause.toString()
    ];
    assert(commitEntry, "commit entry should exist");

    // Key assertion: labels property must NOT be present on commit data
    assertEquals(
      "labels" in commitEntry.is,
      false,
      "labels property should be stripped from commit data even when labels exist",
    );

    // Verify the label fact itself is in the changes (not the labels property)
    const docChanges = commitEntry.is.transaction.args.changes[doc];
    assert(
      LABEL_TYPE in docChanges,
      "label type facts should be in changes",
    );

    reader.cancel();
  },
);

test(
  "provider subscription - unclassified content passes through",
  store,
  async (session) => {
    const clock = new Clock();
    const memory = Consumer.open({ as: alice, session, clock }).mount(
      alice.did(),
    );

    // Create initial fact
    const v1 = Fact.assert({
      the,
      of: doc,
      is: { v: 1 },
    });
    const r1 = await memory.transact({ changes: Changes.from([v1]) });
    assert(r1.ok);

    // Subscribe to commits
    const query = memory.query({
      select: {
        [alice.did()]: {
          "application/commit+json": {
            _: {},
          },
        },
      },
    });
    const subscription = query.subscribe();
    const reader = subscription.getReader();
    const pendingRead = reader.read();

    // Create unclassified content (no label)
    const v2 = Fact.assert({
      the,
      of: doc,
      is: { public: "data" },
      cause: v1,
    });

    const r2 = await memory.transact({
      changes: Changes.from([v2]),
    });
    assert(r2.ok);
    const c2 = Commit.toRevision(r2.ok);

    const result = await pendingRead;
    assertFalse(result.done);

    // deno-lint-ignore no-explicit-any
    const commit = result.value.commit as any;
    const commitEntry = commit[alice.did()]?.["application/commit+json"]?.[
      c2.cause.toString()
    ];
    assert(commitEntry, "commit entry should exist");

    // No labels property (none were attached)
    assertEquals(
      "labels" in commitEntry.is,
      false,
      "labels property should not exist for unlabeled commits",
    );

    // The content should be present (not redacted)
    const docChanges = commitEntry.is.transaction.args.changes[doc];
    const jsonChanges = docChanges[the];
    const causeKeys = Object.keys(jsonChanges);
    assertEquals(causeKeys.length, 1, "should have one change entry");

    const changeValue = jsonChanges[causeKeys[0]];
    assertEquals(
      changeValue.is,
      { public: "data" },
      "unclassified content should pass through unchanged",
    );

    reader.cancel();
  },
);

// =============================================================================
// Space-schema call site tests (space-schema.ts:426)
// These test the query path where commit log data is included in results
// =============================================================================

test(
  "query with commit log - labels stripped from commit data (space-schema call site)",
  store,
  async (session) => {
    const clock = new Clock();
    const memory = Consumer.open({ as: alice, session, clock }).mount(
      alice.did(),
    );

    // Create content with a label
    const v1 = Fact.assert({
      the,
      of: doc,
      is: { v: 1 },
    });
    const v1_label = Fact.assert({
      the: LABEL_TYPE,
      of: doc,
      is: { classification: ["confidential"] },
    });

    const r1 = await memory.transact({
      changes: Changes.from([v1, v1_label]),
    });
    assert(r1.ok);
    const c1 = Commit.toRevision(r1.ok);

    // Query for commit log data directly
    const query = await memory.query({
      select: {
        [alice.did()]: {
          "application/commit+json": {
            [c1.cause.toString()]: {},
          },
        },
      },
    });
    assert(query.ok, "query should succeed");

    // Structure is: selection[spaceDID][spaceDID]["application/commit+json"][cause]
    const spaceSelection = query.ok.selection[alice.did()];
    assert(spaceSelection, "should have space in selection");

    const innerSelection = spaceSelection[alice.did()];
    assert(innerSelection, "should have inner space selection");

    const commitTypeData = innerSelection["application/commit+json"] as Record<
      string,
      unknown
    >;
    assert(commitTypeData, "should have commit type data");

    const commitEntry = commitTypeData[c1.cause.toString()] as {
      is: Record<string, unknown>;
      since: number;
    };
    assert(commitEntry, "should have our specific commit");
    assert(commitEntry.is, "commit entry should have 'is' property");

    // Key assertion: labels property must NOT be present on the commit data
    // This verifies space-schema.ts:426 call site is working correctly
    assertEquals(
      "labels" in commitEntry.is,
      false,
      "labels should be stripped from commit data in query results (space-schema call site)",
    );

    // Verify the commit data has the expected structure
    assert("since" in commitEntry.is, "commit data should have since");
    assert(
      "transaction" in commitEntry.is,
      "commit data should have transaction",
    );
  },
);
