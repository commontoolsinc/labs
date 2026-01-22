/**
 * Tests for redactCommitData call sites.
 *
 * These tests verify that commit data is properly handled at each call site:
 * - provider.ts: When commits are broadcast to subscribers
 * - space-schema.ts: When commit log data is included in query results
 */
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
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

describe("redactCommitData call sites", () => {
  let provider: Provider.Provider<Provider.Protocol>;
  let session: Provider.ProviderSession<Provider.Protocol>;

  beforeEach(async () => {
    const open = await Provider.open({
      serviceDid,
      store,
    });
    assert(open.ok, "should open provider");
    provider = open.ok;
    session = provider.session();
  });

  afterEach(async () => {
    await provider.close();
  });

  describe("provider.ts call site (subscription broadcast)", () => {
    it("includes label facts in changes", async () => {
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

      // Create content with a label
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

      // Verify the label fact itself is in the changes
      const docChanges = commitEntry.is.transaction.args.changes[doc];
      assert(LABEL_TYPE in docChanges, "label type facts should be in changes");

      reader.cancel();
    });

    it("passes through unclassified content unchanged", async () => {
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
    });
  });

  describe("space-schema.ts call site (query results)", () => {
    it("includes commit data structure in query results", async () => {
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

      const commitTypeData = innerSelection[
        "application/commit+json"
      ] as Record<string, unknown>;
      assert(commitTypeData, "should have commit type data");

      const commitEntry = commitTypeData[c1.cause.toString()] as {
        is: Record<string, unknown>;
        since: number;
      };
      assert(commitEntry, "should have our specific commit");
      assert(commitEntry.is, "commit entry should have 'is' property");

      // Verify the commit data has the expected structure
      assert("since" in commitEntry.is, "commit data should have since");
      assert(
        "transaction" in commitEntry.is,
        "commit data should have transaction",
      );
    });
  });
});
