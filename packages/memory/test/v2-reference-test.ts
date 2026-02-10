import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  computeCommitHash,
  computeFactHash,
  computeValueHash,
  EMPTY,
  fromWireFormat,
  isEmptyReference,
  toWireFormat,
} from "../v2-reference.ts";
import type {
  ClientCommit,
  Delete,
  EntityId,
  Fact,
  PatchWrite,
  SetWrite,
} from "../v2-types.ts";
import type { Reference } from "merkle-reference";

const ENTITY_A: EntityId = "urn:entity:aaa";
const ENTITY_B: EntityId = "urn:entity:bbb";

// Use the EMPTY reference as a parent for genesis facts
const parentA = EMPTY(ENTITY_A);

// ---------------------------------------------------------------------------
// EMPTY
// ---------------------------------------------------------------------------

Deno.test("EMPTY: produces deterministic reference", () => {
  const ref1 = EMPTY(ENTITY_A);
  const ref2 = EMPTY(ENTITY_A);
  assertEquals(ref1.toString(), ref2.toString());
});

Deno.test("EMPTY: different entity IDs produce different references", () => {
  const ref1 = EMPTY(ENTITY_A);
  const ref2 = EMPTY(ENTITY_B);
  assertNotEquals(ref1.toString(), ref2.toString());
});

// ---------------------------------------------------------------------------
// computeFactHash
// ---------------------------------------------------------------------------

Deno.test("computeFactHash: SetWrite is deterministic", () => {
  const fact: SetWrite = {
    type: "set",
    id: ENTITY_A,
    value: { hello: "world" },
    parent: parentA,
  };
  const hash1 = computeFactHash(fact);
  const hash2 = computeFactHash(fact);
  assertEquals(hash1.toString(), hash2.toString());
});

Deno.test("computeFactHash: same content produces same hash", () => {
  const fact1: SetWrite = {
    type: "set",
    id: ENTITY_A,
    value: 42,
    parent: parentA,
  };
  const fact2: SetWrite = {
    type: "set",
    id: ENTITY_A,
    value: 42,
    parent: parentA,
  };
  assertEquals(
    computeFactHash(fact1).toString(),
    computeFactHash(fact2).toString(),
  );
});

Deno.test("computeFactHash: different values produce different hashes", () => {
  const fact1: SetWrite = {
    type: "set",
    id: ENTITY_A,
    value: 1,
    parent: parentA,
  };
  const fact2: SetWrite = {
    type: "set",
    id: ENTITY_A,
    value: 2,
    parent: parentA,
  };
  assertNotEquals(
    computeFactHash(fact1).toString(),
    computeFactHash(fact2).toString(),
  );
});

Deno.test("computeFactHash: PatchWrite hash includes ops", () => {
  const fact1: PatchWrite = {
    type: "patch",
    id: ENTITY_A,
    ops: [{ op: "replace", path: "/a", value: 1 }],
    parent: parentA,
  };
  const fact2: PatchWrite = {
    type: "patch",
    id: ENTITY_A,
    ops: [{ op: "replace", path: "/a", value: 2 }],
    parent: parentA,
  };
  assertNotEquals(
    computeFactHash(fact1).toString(),
    computeFactHash(fact2).toString(),
  );
});

Deno.test("computeFactHash: Delete hash includes parent", () => {
  const parentB = EMPTY(ENTITY_B);
  const fact1: Delete = {
    type: "delete",
    id: ENTITY_A,
    parent: parentA,
  };
  const fact2: Delete = {
    type: "delete",
    id: ENTITY_A,
    parent: parentB,
  };
  assertNotEquals(
    computeFactHash(fact1).toString(),
    computeFactHash(fact2).toString(),
  );
});

Deno.test("computeFactHash: different fact types produce different hashes", () => {
  const setFact: Fact = {
    type: "set",
    id: ENTITY_A,
    value: null,
    parent: parentA,
  };
  const deleteFact: Fact = {
    type: "delete",
    id: ENTITY_A,
    parent: parentA,
  };
  assertNotEquals(
    computeFactHash(setFact).toString(),
    computeFactHash(deleteFact).toString(),
  );
});

// ---------------------------------------------------------------------------
// computeValueHash
// ---------------------------------------------------------------------------

Deno.test("computeValueHash: deterministic", () => {
  const hash1 = computeValueHash({ key: "value" });
  const hash2 = computeValueHash({ key: "value" });
  assertEquals(hash1.toString(), hash2.toString());
});

Deno.test("computeValueHash: same value produces same hash (deduplication)", () => {
  const hash1 = computeValueHash(42);
  const hash2 = computeValueHash(42);
  assertEquals(hash1.toString(), hash2.toString());
});

Deno.test("computeValueHash: different values produce different hashes", () => {
  const hash1 = computeValueHash("hello");
  const hash2 = computeValueHash("world");
  assertNotEquals(hash1.toString(), hash2.toString());
});

// ---------------------------------------------------------------------------
// computeCommitHash
// ---------------------------------------------------------------------------

Deno.test("computeCommitHash: deterministic", () => {
  const commit: ClientCommit = {
    reads: {
      confirmed: [{ id: ENTITY_A, hash: parentA, version: 0 }],
      pending: [],
    },
    operations: [
      { op: "set", id: ENTITY_A, value: 1, parent: parentA },
    ],
  };
  const hash1 = computeCommitHash(commit);
  const hash2 = computeCommitHash(commit);
  assertEquals(hash1.toString(), hash2.toString());
});

// ---------------------------------------------------------------------------
// Wire format conversion
// ---------------------------------------------------------------------------

Deno.test("toWireFormat: returns CID link object", () => {
  const ref = EMPTY(ENTITY_A);
  const wire = toWireFormat(ref);
  assert(typeof wire["/"] === "string");
});

Deno.test("toWireFormat/fromWireFormat: roundtrip", () => {
  const ref = computeValueHash({ test: "roundtrip" });
  const wire = toWireFormat(ref);
  const restored = fromWireFormat(wire);
  assertEquals(ref.toString(), restored.toString());
});

// ---------------------------------------------------------------------------
// isEmptyReference
// ---------------------------------------------------------------------------

Deno.test("isEmptyReference: true for EMPTY(id)", () => {
  const ref = EMPTY(ENTITY_A);
  assert(isEmptyReference(ref, ENTITY_A));
});

Deno.test("isEmptyReference: false for other references", () => {
  const ref = computeValueHash(42);
  assert(!isEmptyReference(ref as unknown as Reference, ENTITY_A));
});

Deno.test("isEmptyReference: false for EMPTY of different entity", () => {
  const ref = EMPTY(ENTITY_B);
  assert(!isEmptyReference(ref, ENTITY_A));
});
