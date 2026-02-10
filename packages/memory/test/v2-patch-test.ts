import { assertEquals, assertThrows } from "@std/assert";
import {
  applyOp,
  applyPatch,
  getAtPath,
  parsePath,
  PatchError,
  removeAtPath,
  setAtPath,
} from "../v2-patch.ts";
import type { PatchOp } from "../v2-types.ts";

// ---------------------------------------------------------------------------
// parsePath
// ---------------------------------------------------------------------------

Deno.test("parsePath: empty string returns empty array", () => {
  assertEquals(parsePath(""), []);
});

Deno.test("parsePath: root slash returns single empty segment", () => {
  assertEquals(parsePath("/"), [""]);
});

Deno.test("parsePath: simple path", () => {
  assertEquals(parsePath("/foo/bar/0"), ["foo", "bar", "0"]);
});

Deno.test("parsePath: escapes ~0 to ~ and ~1 to /", () => {
  assertEquals(parsePath("/a~0b/c~1d"), ["a~b", "c/d"]);
});

Deno.test("parsePath: throws on path without leading /", () => {
  assertThrows(() => parsePath("foo"), PatchError);
});

// ---------------------------------------------------------------------------
// getAtPath
// ---------------------------------------------------------------------------

Deno.test("getAtPath: root returns whole value", () => {
  const value = { a: 1 };
  assertEquals(getAtPath(value, []), { a: 1 });
});

Deno.test("getAtPath: object property", () => {
  const value = { a: { b: 42 } };
  assertEquals(getAtPath(value, ["a", "b"]), 42);
});

Deno.test("getAtPath: array index", () => {
  const value = { items: [10, 20, 30] };
  assertEquals(getAtPath(value, ["items", "1"]), 20);
});

Deno.test("getAtPath: throws on non-existent property", () => {
  assertThrows(() => getAtPath({ a: 1 }, ["b"]), PatchError);
});

Deno.test("getAtPath: throws on out-of-bounds array index", () => {
  assertThrows(() => getAtPath([1, 2], ["5"]), PatchError);
});

Deno.test("getAtPath: throws when navigating through primitive", () => {
  assertThrows(() => getAtPath({ a: 42 }, ["a", "b"]), PatchError);
});

// ---------------------------------------------------------------------------
// setAtPath
// ---------------------------------------------------------------------------

Deno.test("setAtPath: root replaces entire value", () => {
  assertEquals(setAtPath({ a: 1 }, [], 42), 42);
});

Deno.test("setAtPath: object property", () => {
  const result = setAtPath({ a: 1, b: 2 }, ["a"], 99);
  assertEquals(result, { a: 99, b: 2 });
});

Deno.test("setAtPath: nested object", () => {
  const result = setAtPath({ a: { b: 1 } }, ["a", "b"], 42);
  assertEquals(result, { a: { b: 42 } });
});

Deno.test("setAtPath: array element", () => {
  const result = setAtPath([1, 2, 3], ["1"], 99);
  assertEquals(result, [1, 99, 3]);
});

// ---------------------------------------------------------------------------
// removeAtPath
// ---------------------------------------------------------------------------

Deno.test("removeAtPath: object property", () => {
  const result = removeAtPath({ a: 1, b: 2 }, ["a"]);
  assertEquals(result, { b: 2 });
});

Deno.test("removeAtPath: array element", () => {
  const result = removeAtPath([1, 2, 3], ["1"]);
  assertEquals(result, [1, 3]);
});

Deno.test("removeAtPath: throws on root removal", () => {
  assertThrows(() => removeAtPath({ a: 1 }, []), PatchError);
});

Deno.test("removeAtPath: throws on non-existent property", () => {
  assertThrows(() => removeAtPath({ a: 1 }, ["b"]), PatchError);
});

// ---------------------------------------------------------------------------
// replace
// ---------------------------------------------------------------------------

Deno.test("replace: replaces root value", () => {
  const result = applyOp({ a: 1 }, { op: "replace", path: "", value: 42 });
  assertEquals(result, 42);
});

Deno.test("replace: replaces nested property", () => {
  const result = applyOp(
    { a: { b: 1 } },
    { op: "replace", path: "/a/b", value: 99 },
  );
  assertEquals(result, { a: { b: 99 } });
});

Deno.test("replace: replaces array element", () => {
  const result = applyOp(
    [10, 20, 30],
    { op: "replace", path: "/1", value: 99 },
  );
  assertEquals(result, [10, 99, 30]);
});

Deno.test("replace: throws on non-existent path", () => {
  assertThrows(
    () => applyOp({ a: 1 }, { op: "replace", path: "/b", value: 42 }),
    PatchError,
  );
});

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

Deno.test("add: adds new object property", () => {
  const result = applyOp(
    { a: 1 },
    { op: "add", path: "/b", value: 2 },
  );
  assertEquals(result, { a: 1, b: 2 });
});

Deno.test("add: replaces existing object property", () => {
  const result = applyOp(
    { a: 1 },
    { op: "add", path: "/a", value: 99 },
  );
  assertEquals(result, { a: 99 });
});

Deno.test("add: inserts into array at index", () => {
  const result = applyOp(
    [1, 2, 3],
    { op: "add", path: "/1", value: 99 },
  );
  assertEquals(result, [1, 99, 2, 3]);
});

Deno.test("add: appends to array with dash", () => {
  const result = applyOp(
    [1, 2, 3],
    { op: "add", path: "/-", value: 4 },
  );
  assertEquals(result, [1, 2, 3, 4]);
});

Deno.test("add: adds to root replaces document", () => {
  const result = applyOp({ a: 1 }, { op: "add", path: "", value: 42 });
  assertEquals(result, 42);
});

Deno.test("add: adds nested property", () => {
  const result = applyOp(
    { a: {} },
    { op: "add", path: "/a/b", value: 1 },
  );
  assertEquals(result, { a: { b: 1 } });
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

Deno.test("remove: removes object property", () => {
  const result = applyOp(
    { a: 1, b: 2 },
    { op: "remove", path: "/a" },
  );
  assertEquals(result, { b: 2 });
});

Deno.test("remove: removes array element", () => {
  const result = applyOp(
    [1, 2, 3],
    { op: "remove", path: "/1" },
  );
  assertEquals(result, [1, 3]);
});

Deno.test("remove: throws on non-existent path", () => {
  assertThrows(
    () => applyOp({ a: 1 }, { op: "remove", path: "/b" }),
    PatchError,
  );
});

// ---------------------------------------------------------------------------
// move
// ---------------------------------------------------------------------------

Deno.test("move: moves property within object", () => {
  const result = applyOp(
    { a: 1, b: 2 },
    { op: "move", from: "/a", path: "/c" },
  );
  assertEquals(result, { b: 2, c: 1 });
});

Deno.test("move: moves array element", () => {
  const result = applyOp(
    { items: [1, 2, 3], dest: null },
    { op: "move", from: "/items/0", path: "/dest" },
  );
  assertEquals(result, { items: [2, 3], dest: 1 });
});

Deno.test("move: throws when from path doesn't exist", () => {
  assertThrows(
    () => applyOp({ a: 1 }, { op: "move", from: "/b", path: "/c" }),
    PatchError,
  );
});

// ---------------------------------------------------------------------------
// splice
// ---------------------------------------------------------------------------

Deno.test("splice: inserts elements", () => {
  const result = applyOp(
    { arr: [1, 2, 3] },
    { op: "splice", path: "/arr", index: 1, remove: 0, add: [10, 20] },
  );
  assertEquals(result, { arr: [1, 10, 20, 2, 3] });
});

Deno.test("splice: removes elements", () => {
  const result = applyOp(
    { arr: [1, 2, 3, 4] },
    { op: "splice", path: "/arr", index: 1, remove: 2, add: [] },
  );
  assertEquals(result, { arr: [1, 4] });
});

Deno.test("splice: replaces elements", () => {
  const result = applyOp(
    { arr: [1, 2, 3] },
    { op: "splice", path: "/arr", index: 0, remove: 2, add: [10, 20, 30] },
  );
  assertEquals(result, { arr: [10, 20, 30, 3] });
});

Deno.test("splice: at end of array", () => {
  const result = applyOp(
    [1, 2],
    { op: "splice", path: "", index: 2, remove: 0, add: [3, 4] },
  );
  assertEquals(result, [1, 2, 3, 4]);
});

Deno.test("splice: on empty array", () => {
  const result = applyOp(
    { arr: [] },
    { op: "splice", path: "/arr", index: 0, remove: 0, add: [1, 2] },
  );
  assertEquals(result, { arr: [1, 2] });
});

Deno.test("splice: throws on non-array target", () => {
  assertThrows(
    () =>
      applyOp(
        { a: "string" },
        { op: "splice", path: "/a", index: 0, remove: 0, add: [1] },
      ),
    PatchError,
  );
});

Deno.test("splice: throws on out-of-bounds index", () => {
  assertThrows(
    () =>
      applyOp(
        [1, 2],
        { op: "splice", path: "", index: 5, remove: 0, add: [] },
      ),
    PatchError,
  );
});

Deno.test("splice: throws on negative remove count", () => {
  assertThrows(
    () =>
      applyOp(
        [1, 2, 3],
        { op: "splice", path: "", index: 0, remove: -1, add: [] },
      ),
    PatchError,
  );
});

// ---------------------------------------------------------------------------
// applyPatch (multiple operations)
// ---------------------------------------------------------------------------

Deno.test("applyPatch: applies multiple ops in sequence", () => {
  const ops: PatchOp[] = [
    { op: "add", path: "/x", value: 1 },
    { op: "add", path: "/y", value: 2 },
    { op: "replace", path: "/x", value: 10 },
  ];
  const result = applyPatch({}, ops);
  assertEquals(result, { x: 10, y: 2 });
});

Deno.test("applyPatch: empty ops returns unchanged value", () => {
  const value = { a: 1 };
  const result = applyPatch(value, []);
  assertEquals(result, { a: 1 });
});

Deno.test("applyPatch: ordering matters", () => {
  // First add, then remove
  const result1 = applyPatch({ a: 1 }, [
    { op: "add", path: "/b", value: 2 },
    { op: "remove", path: "/a" },
  ]);
  assertEquals(result1, { b: 2 });

  // Reverse order would fail because /a needs to exist for remove
  // (but /b wouldn't exist yet for a different sequence)
  const result2 = applyPatch({ a: 1 }, [
    { op: "remove", path: "/a" },
    { op: "add", path: "/b", value: 2 },
  ]);
  assertEquals(result2, { b: 2 });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

Deno.test("edge case: deeply nested path", () => {
  const value = { a: { b: { c: { d: 1 } } } };
  const result = applyOp(value, {
    op: "replace",
    path: "/a/b/c/d",
    value: 42,
  });
  assertEquals(result, { a: { b: { c: { d: 42 } } } });
});

Deno.test("edge case: path with escaped characters", () => {
  const value = { "a/b": { "c~d": 1 } };
  const result = applyOp(value, {
    op: "replace",
    path: "/a~1b/c~0d",
    value: 42,
  });
  assertEquals(result, { "a/b": { "c~d": 42 } });
});

Deno.test("edge case: numeric keys in objects vs array indices", () => {
  const objValue = { "0": "zero", "1": "one" };
  const result = applyOp(objValue, {
    op: "replace",
    path: "/0",
    value: "ZERO",
  });
  assertEquals(result, { "0": "ZERO", "1": "one" });
});

Deno.test("edge case: null value handling", () => {
  const result = applyOp(
    { a: null },
    { op: "replace", path: "/a", value: 42 },
  );
  assertEquals(result, { a: 42 });
});

Deno.test("edge case: replace with null", () => {
  const result = applyOp(
    { a: 42 },
    { op: "replace", path: "/a", value: null },
  );
  assertEquals(result, { a: null });
});
