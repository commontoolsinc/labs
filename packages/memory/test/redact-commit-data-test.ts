import {
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import { redactCommitData } from "../space.ts";
import type { CommitData, FactSelection } from "../interface.ts";
import * as Transaction from "../transaction.ts";
import * as Changes from "../changes.ts";
import * as Fact from "../fact.ts";
import { alice, space } from "./principal.ts";

const the = "application/json" as const;
const labelType = "application/label+json" as const;

Deno.test("redactCommitData - returns same object when no labels", () => {
  const v1 = Fact.assert({ the, of: "of:test-doc", is: { value: 1 } });
  const transaction = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([v1]),
  });
  const commitData: CommitData = {
    since: 0,
    transaction,
  };

  const result = redactCommitData(commitData);

  // Should return the exact same object reference when no labels
  assertStrictEquals(result, commitData);
});

Deno.test("redactCommitData - returns new object when labels present", () => {
  const v1 = Fact.assert({ the, of: "of:test-doc", is: { value: 1 } });
  const transaction = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([v1]),
  });
  const labels: FactSelection = {} as FactSelection;
  const commitData: CommitData = {
    since: 0,
    transaction,
    labels,
  };

  const result = redactCommitData(commitData);

  // Should return a different object reference
  assertNotStrictEquals(result, commitData);
});

Deno.test("redactCommitData - result has no labels property", () => {
  const v1 = Fact.assert({ the, of: "of:test-doc", is: { value: 1 } });
  const transaction = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([v1]),
  });
  const labels: FactSelection = {} as FactSelection;
  const commitData: CommitData = {
    since: 0,
    transaction,
    labels,
  };

  const result = redactCommitData(commitData);

  // Result should not have labels property
  assertEquals("labels" in result, false);
  assertEquals(result.labels, undefined);
});

Deno.test("redactCommitData - preserves since value", () => {
  const v1 = Fact.assert({ the, of: "of:test-doc", is: { value: 1 } });
  const transaction = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([v1]),
  });
  const labels: FactSelection = {} as FactSelection;
  const commitData: CommitData = {
    since: 42,
    transaction,
    labels,
  };

  const result = redactCommitData(commitData);

  assertEquals(result.since, 42);
});

Deno.test("redactCommitData - preserves transaction metadata", () => {
  const v1 = Fact.assert({ the, of: "of:test-doc", is: { value: 1 } });
  const transaction = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
    meta: { message: "test commit" },
    changes: Changes.from([v1]),
  });
  const labels: FactSelection = {} as FactSelection;
  const commitData: CommitData = {
    since: 5,
    transaction,
    labels,
  };

  const result = redactCommitData(commitData);

  // Should preserve transaction metadata
  assertEquals(result.transaction.iss, alice.did());
  assertEquals(result.transaction.sub, space.did());
  assertEquals(result.transaction.cmd, "/memory/transact");
  assertEquals(result.transaction.meta, { message: "test commit" });
});

Deno.test("redactCommitData - copies changes to new object", () => {
  const v1 = Fact.assert({ the, of: "of:doc1", is: { a: 1 } });
  const v2 = Fact.assert({ the, of: "of:doc2", is: { b: 2 } });
  const transaction = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([v1, v2]),
  });
  const labels: FactSelection = {} as FactSelection;
  const commitData: CommitData = {
    since: 0,
    transaction,
    labels,
  };

  const result = redactCommitData(commitData);

  // Changes should be copied (different reference)
  assertNotStrictEquals(
    result.transaction.args.changes,
    transaction.args.changes,
  );

  // But content should be equivalent - both docs should be present
  assertEquals("of:doc1" in result.transaction.args.changes, true);
  assertEquals("of:doc2" in result.transaction.args.changes, true);
});

Deno.test("redactCommitData - skips claim entries (value === true)", () => {
  const v1 = Fact.assert({ the, of: "of:doc1", is: { a: 1 } });
  const v2 = Fact.claim(v1); // This creates a claim
  const transaction = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([v1, v2]),
  });
  const labels: FactSelection = {} as FactSelection;
  const commitData: CommitData = {
    since: 0,
    transaction,
    labels,
  };

  const result = redactCommitData(commitData);

  // The assertion should be present, but the claim (true) should be skipped
  const doc1Changes = result.transaction.args.changes["of:doc1"];
  assertEquals(the in doc1Changes, true);

  // Count the entries - should only have the assertion, not the claim
  const causeEntries = Object.entries(doc1Changes[the]);
  // Filter out entries where value is `true` (claims)
  const nonClaimEntries = causeEntries.filter(([_, val]) => val !== true);
  assertEquals(nonClaimEntries.length, 1);
});

Deno.test("redactCommitData - includes label type facts unchanged", () => {
  const v1 = Fact.assert({ the, of: "of:doc1", is: { a: 1 } });
  const label = Fact.assert({
    the: labelType,
    of: "of:doc1",
    is: { classifications: ["secret"] },
  });
  const transaction = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([v1, label]),
  });
  const labels: FactSelection = {} as FactSelection;
  const commitData: CommitData = {
    since: 0,
    transaction,
    labels,
  };

  const result = redactCommitData(commitData);

  // Label type facts should be included in the result
  const doc1Changes = result.transaction.args.changes["of:doc1"];
  assertEquals(labelType in doc1Changes, true);
});
