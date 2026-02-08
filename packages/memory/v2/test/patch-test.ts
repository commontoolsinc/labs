import { assertEquals, assertThrows } from "@std/assert";
import { applyOp, applyPatch, parsePointer } from "../patch.ts";
import type { PatchOp } from "../types.ts";

Deno.test("parsePointer", async (t) => {
  await t.step("empty string returns empty array", () => {
    assertEquals(parsePointer(""), []);
  });

  await t.step("parses simple path", () => {
    assertEquals(parsePointer("/foo"), ["foo"]);
    assertEquals(parsePointer("/foo/bar"), ["foo", "bar"]);
    assertEquals(parsePointer("/foo/0/bar"), ["foo", "0", "bar"]);
  });

  await t.step("handles escaped characters", () => {
    assertEquals(parsePointer("/a~0b"), ["a~b"]);
    assertEquals(parsePointer("/a~1b"), ["a/b"]);
    assertEquals(parsePointer("/~01"), ["~1"]);
  });

  await t.step("throws on invalid pointer", () => {
    assertThrows(() => parsePointer("foo"), Error, "must start with");
  });
});

Deno.test("replace", async (t) => {
  await t.step("replaces root value", () => {
    const result = applyOp({ a: 1 }, { op: "replace", path: "", value: 42 });
    assertEquals(result, 42);
  });

  await t.step("replaces nested property", () => {
    const result = applyOp(
      { a: { b: 1 }, c: 2 },
      { op: "replace", path: "/a/b", value: 99 },
    );
    assertEquals(result, { a: { b: 99 }, c: 2 });
  });

  await t.step("replaces array element", () => {
    const result = applyOp(
      [1, 2, 3],
      { op: "replace", path: "/1", value: 42 },
    );
    assertEquals(result, [1, 42, 3]);
  });

  await t.step("throws on non-existent path", () => {
    assertThrows(
      () => applyOp({ a: 1 }, { op: "replace", path: "/b", value: 2 }),
    );
  });
});

Deno.test("add", async (t) => {
  await t.step("adds new property to object", () => {
    const result = applyOp(
      { a: 1 },
      { op: "add", path: "/b", value: 2 },
    );
    assertEquals(result, { a: 1, b: 2 });
  });

  await t.step("adds element to end of array with -", () => {
    const result = applyOp(
      [1, 2],
      { op: "add", path: "/-", value: 3 },
    );
    assertEquals(result, [1, 2, 3]);
  });

  await t.step("inserts element at array index", () => {
    const result = applyOp(
      [1, 3],
      { op: "add", path: "/1", value: 2 },
    );
    assertEquals(result, [1, 2, 3]);
  });

  await t.step("adds nested property", () => {
    const result = applyOp(
      { a: { b: 1 } },
      { op: "add", path: "/a/c", value: 2 },
    );
    assertEquals(result, { a: { b: 1, c: 2 } });
  });

  await t.step("replaces existing property", () => {
    const result = applyOp(
      { a: 1 },
      { op: "add", path: "/a", value: 2 },
    );
    assertEquals(result, { a: 2 });
  });
});

Deno.test("remove", async (t) => {
  await t.step("removes property from object", () => {
    const result = applyOp(
      { a: 1, b: 2 },
      { op: "remove", path: "/a" },
    );
    assertEquals(result, { b: 2 });
  });

  await t.step("removes element from array", () => {
    const result = applyOp(
      [1, 2, 3],
      { op: "remove", path: "/1" },
    );
    assertEquals(result, [1, 3]);
  });

  await t.step("removes nested property", () => {
    const result = applyOp(
      { a: { b: 1, c: 2 } },
      { op: "remove", path: "/a/c" },
    );
    assertEquals(result, { a: { b: 1 } });
  });

  await t.step("throws on remove root", () => {
    assertThrows(
      () => applyOp({ a: 1 }, { op: "remove", path: "" }),
    );
  });

  await t.step("throws on non-existent path", () => {
    assertThrows(
      () => applyOp({ a: 1 }, { op: "remove", path: "/b" }),
    );
  });
});

Deno.test("move", async (t) => {
  await t.step("moves property within object", () => {
    const result = applyOp(
      { a: 1, b: 2 },
      { op: "move", from: "/a", path: "/c" },
    );
    assertEquals(result, { b: 2, c: 1 });
  });

  await t.step("moves array element", () => {
    const result = applyOp(
      { a: [1, 2, 3, 4] },
      { op: "move", from: "/a/1", path: "/a/3" },
    );
    assertEquals(result, { a: [1, 3, 4, 2] });
  });

  await t.step("moves nested value", () => {
    const result = applyOp(
      { a: { x: 1 }, b: {} },
      { op: "move", from: "/a/x", path: "/b/y" },
    );
    assertEquals(result, { a: {}, b: { y: 1 } });
  });
});

Deno.test("splice", async (t) => {
  await t.step("removes elements", () => {
    const result = applyOp(
      [1, 2, 3, 4, 5],
      { op: "splice", path: "", index: 1, remove: 2, add: [] },
    );
    assertEquals(result, [1, 4, 5]);
  });

  await t.step("inserts elements", () => {
    const result = applyOp(
      [1, 4],
      { op: "splice", path: "", index: 1, remove: 0, add: [2, 3] },
    );
    assertEquals(result, [1, 2, 3, 4]);
  });

  await t.step("replaces elements", () => {
    const result = applyOp(
      [1, 2, 3],
      { op: "splice", path: "", index: 1, remove: 1, add: [20, 30] },
    );
    assertEquals(result, [1, 20, 30, 3]);
  });

  await t.step("splices nested array", () => {
    const result = applyOp(
      { items: [1, 2, 3] },
      { op: "splice", path: "/items", index: 0, remove: 1, add: [10, 20] },
    );
    assertEquals(result, { items: [10, 20, 2, 3] });
  });

  await t.step("throws on non-array target", () => {
    assertThrows(
      () =>
        applyOp(
          { items: "not an array" },
          {
            op: "splice",
            path: "/items",
            index: 0,
            remove: 0,
            add: [1],
          },
        ),
    );
  });

  await t.step("throws on out-of-bounds index", () => {
    assertThrows(
      () =>
        applyOp([1, 2], {
          op: "splice",
          path: "",
          index: 5,
          remove: 0,
          add: [],
        }),
    );
  });
});

Deno.test("applyPatch - sequential operations", async (t) => {
  await t.step("applies multiple operations in sequence", () => {
    const ops: PatchOp[] = [
      { op: "add", path: "/name", value: "Alice" },
      { op: "add", path: "/age", value: 30 },
      { op: "replace", path: "/age", value: 31 },
    ];
    const result = applyPatch({}, ops);
    assertEquals(result, { name: "Alice", age: 31 });
  });

  await t.step("empty ops returns unchanged value", () => {
    const state = { a: 1 };
    const result = applyPatch(state, []);
    assertEquals(result, { a: 1 });
  });

  await t.step("complex multi-step patch", () => {
    const initial = {
      users: [
        { name: "Alice", tags: ["admin"] },
        { name: "Bob", tags: ["user"] },
      ],
    };

    const ops: PatchOp[] = [
      // Add a tag to Alice
      { op: "add", path: "/users/0/tags/-", value: "editor" },
      // Remove Bob
      { op: "remove", path: "/users/1" },
      // Add Charlie
      {
        op: "add",
        path: "/users/-",
        value: { name: "Charlie", tags: ["user"] },
      },
      // Replace Alice's name
      { op: "replace", path: "/users/0/name", value: "Alice Smith" },
    ];

    const result = applyPatch(initial, ops);
    assertEquals(result, {
      users: [
        { name: "Alice Smith", tags: ["admin", "editor"] },
        { name: "Charlie", tags: ["user"] },
      ],
    });
  });
});

Deno.test("applyPatch - does not mutate input", () => {
  const state = { a: { b: 1 } };
  const result = applyPatch(state, [
    { op: "replace", path: "/a/b", value: 2 },
  ]);
  assertEquals(state, { a: { b: 1 } }); // unchanged
  assertEquals(result, { a: { b: 2 } });
});
