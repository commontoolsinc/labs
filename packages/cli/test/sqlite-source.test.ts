// Pure-helper unit tests for the Phase 7 `cf piece link ... sqlite:<absPath>`
// source parse + deterministic handle-id derivation.

import { assertEquals, assertThrows } from "@std/assert";
import {
  deriveDiskHandleId,
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
