// Pure-helper unit tests for the Phase 7 `cf piece link ... sqlite:<absPath>`
// source parse + deterministic handle-id derivation.

import { assertEquals, assertThrows } from "@std/assert";
import {
  deriveDiskHandleId,
  diskHandleSeed,
  parseSqliteSource,
} from "../lib/sqlite-source.ts";

const SPACE = "did:key:z6MkSpaceA";
const SPACE_B = "did:key:z6MkSpaceB";

Deno.test("parseSqliteSource recognizes an absolute sqlite: source", () => {
  assertEquals(parseSqliteSource("sqlite:/abs/reference-data.db"), {
    path: "/abs/reference-data.db",
  });
});

Deno.test("parseSqliteSource returns null for a non-sqlite ref", () => {
  assertEquals(parseSqliteSource("bafypiece1/field"), null);
  assertEquals(parseSqliteSource("baedreiahv63wxwgaem"), null);
});

Deno.test("parseSqliteSource throws on a non-absolute path", () => {
  assertThrows(
    () => parseSqliteSource("sqlite:relative/path.db"),
    Error,
    "absolute",
  );
});

Deno.test("parseSqliteSource throws on an empty path", () => {
  assertThrows(() => parseSqliteSource("sqlite:"), Error, "missing a path");
});

Deno.test("deriveDiskHandleId is idempotent for the same (space, path)", () => {
  const a = deriveDiskHandleId(SPACE, "/data/ref.db");
  const b = deriveDiskHandleId(SPACE, "/data/ref.db");
  assertEquals(a, b);
  assertEquals(typeof a, "string");
});

Deno.test("deriveDiskHandleId differs by path", () => {
  const a = deriveDiskHandleId(SPACE, "/data/ref.db");
  const b = deriveDiskHandleId(SPACE, "/data/other.db");
  assertEquals(a === b, false);
});

Deno.test("deriveDiskHandleId differs by space", () => {
  const a = deriveDiskHandleId(SPACE, "/data/ref.db");
  const b = deriveDiskHandleId(SPACE_B, "/data/ref.db");
  assertEquals(a === b, false);
});

const ID = "fid1:handle";

Deno.test("diskHandleSeed seeds an empty contract on a first link", () => {
  assertEquals(diskHandleSeed(ID, undefined), { id: ID, tables: {}, rev: 0 });
});

Deno.test("diskHandleSeed leaves a declared contract alone on a re-link", () => {
  // The downgrade this guards: `tables[].ifc` carries the per-column read
  // labels, so re-seeding `{}` over a declared contract lowers every column's
  // label to nothing. A contract-less query still returns its rows, so nothing
  // reports the loss — same rows, no label, no error.
  const prior = {
    id: ID,
    tables: {
      records: {
        properties: { body: { ifc: { confidentiality: ["finance"] } } },
      },
    },
    rev: 7,
  };
  assertEquals(diskHandleSeed(ID, prior), undefined);
});

Deno.test("diskHandleSeed leaves the fixed handle properties alone too", () => {
  // `owner` resolves dbOwner() row admission, `scope` partitions the db, and
  // `rev` is what a handle hasher reads to decide a query has new inputs.
  const prior = {
    id: ID,
    tables: {},
    owner: "did:key:z6MkOwner",
    scope: "user",
    rev: 3,
  };
  assertEquals(diskHandleSeed(ID, prior), undefined);
});

Deno.test("diskHandleSeed leaves an already-committed empty contract alone", () => {
  // An empty-but-committed handle is still a committed handle: nothing about
  // it is weaker than a fresh seed, so leaving it alone is the same outcome
  // and keeps the rule one sentence long.
  assertEquals(diskHandleSeed(ID, { id: ID, tables: {}, rev: 0 }), undefined);
});
