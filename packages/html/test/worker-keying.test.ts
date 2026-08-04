/**
 * Tests for VDOM keying utilities.
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  generateChildKeys,
  generateKey,
  keysMatch,
} from "../src/worker/keying.ts";

Deno.test("keying - generateKey", async (t) => {
  await t.step("generates stable keys for strings", () => {
    assertEquals(generateKey("hello"), generateKey("hello"));
    assertNotEquals(generateKey("hello"), generateKey("goodbye"));
  });

  await t.step("generates stable keys for numbers", () => {
    assertEquals(generateKey(42), generateKey(42));
    assertNotEquals(generateKey(42), generateKey(43));
  });

  await t.step("keys a number apart from the string that spells it", () => {
    assertNotEquals(generateKey(42), generateKey("42"));
  });

  await t.step("generates stable keys for null and undefined", () => {
    assertEquals(generateKey(null), generateKey(null));
    assertEquals(generateKey(undefined), generateKey(undefined));
    assertNotEquals(generateKey(null), generateKey(undefined));
    // Both are strings. A key is what a child is identified by, so a child
    // that keys as nothing at all has no identity to be reused under.
    assertEquals(typeof generateKey(undefined), "string");
  });

  await t.step("generates stable keys for objects", () => {
    const obj = { name: "div", type: "vnode" };
    const key1 = generateKey(obj);
    const key2 = generateKey({ name: "div", type: "vnode" });
    assertEquals(key1, key2);
  });

  await t.step("generates different keys for different objects", () => {
    const key1 = generateKey({ name: "div" });
    const key2 = generateKey({ name: "span" });
    assertNotEquals(key1, key2);
  });

  await t.step("generates stable keys for arrays", () => {
    const arr = [1, 2, 3];
    const key1 = generateKey(arr);
    const key2 = generateKey([1, 2, 3]);
    assertEquals(key1, key2);
  });

  await t.step("generates stable keys for nested structures", () => {
    const vnode = {
      type: "vnode",
      name: "div",
      props: { className: "foo" },
      children: ["hello"],
    };
    const key1 = generateKey(vnode);
    const key2 = generateKey({
      type: "vnode",
      name: "div",
      props: { className: "foo" },
      children: ["hello"],
    });
    assertEquals(key1, key2);
  });

  await t.step("handles booleans", () => {
    assertNotEquals(generateKey(true), generateKey(false));
    assertEquals(generateKey(true), generateKey(true));
  });

  // Members that a child can differ by, each of which must key it apart: two
  // children keying alike are reconciled as one, and the second one's content
  // never reaches the DOM.
  await t.step("keys members that differ only in fabric terms", () => {
    const key = (props: Record<string, unknown>) =>
      generateKey({ type: "vnode", name: "div", props });

    assertNotEquals(key({ n: 1n }), key({ n: 2n }));
    assertNotEquals(key({ n: 1n }), key({ n: 1 }));

    // A present-but-undefined member is not an absent one.
    assertNotEquals(key({ n: undefined }), key({}));

    assertNotEquals(key({ n: NaN }), key({ n: null }));
    assertNotEquals(key({ n: -0 }), key({ n: 0 }));
  });

  // Types holding their state somewhere other than their enumerable members,
  // which is where the projection reads a value's content. Each pair below
  // differs only in that state.
  await t.step("keys native types by their own state", () => {
    const key = (v: unknown) => generateKey({ type: "vnode", props: { v } });

    assertNotEquals(key(new Date(0)), key(new Date(1)));
    assertEquals(key(new Date(7)), key(new Date(7)));

    assertNotEquals(key(new Map([["a", 1]])), key(new Map([["a", 2]])));
    assertNotEquals(key(new Map()), key(new Set()));

    assertNotEquals(key(new Set([1])), key(new Set([2])));

    assertNotEquals(
      key(new Uint8Array([1, 2])),
      key(new Uint8Array([1, 3])),
    );

    assertNotEquals(key(new Error("a")), key(new Error("b")));

    assertNotEquals(key(/a/g), key(/a/i));
    assertNotEquals(key(/a/g), key(/b/g));

    // And none of them keys as the empty record an enumeration would give.
    assertNotEquals(key(new Date(0)), key({}));
    assertNotEquals(key(new Map()), key({}));
  });

  await t.step("keys a record whose key this runtime reserves", () => {
    // A projected record is a pair list, so `__proto__` is a datum rather than
    // a key, and never reaches the hash as one.
    const key = (props: Record<string, unknown>) => generateKey({ props });

    assertNotEquals(key({ ["__proto__"]: 1 }), key({ ["__proto__"]: 2 }));
    assertNotEquals(key({ ["constructor"]: 1 }), key({ a: 1 }));
    assertEquals(key({ ["__proto__"]: 1 }), key({ ["__proto__"]: 1 }));
  });

  await t.step("keys a record by its member order", () => {
    assertNotEquals(generateKey({ a: 1, b: 2 }), generateKey({ b: 2, a: 1 }));
  });

  await t.step("keys a hole apart from an undefined element", () => {
    const hole = [1, , 3];
    assertNotEquals(generateKey(hole), generateKey([1, undefined, 3]));
  });

  await t.step("answers a cyclic node instead of following it", () => {
    const cyclic: Record<string, unknown> = { name: "div" };
    cyclic.self = cyclic;
    assertEquals(generateKey(cyclic), generateKey(cyclic));
  });
});

Deno.test("keying - generateChildKeys", async (t) => {
  await t.step("generates unique keys for identical children", () => {
    const children = ["a", "a", "a"];
    const keys = generateChildKeys(children);

    assertEquals(keys.length, 3);
    // Keys should all be different
    assertEquals(new Set(keys).size, 3);
    // Identical children are told apart by their occurrence count alone.
    assertEquals(keys[0], `${generateKey("a")}-0`);
    assertEquals(keys[1], `${generateKey("a")}-1`);
    assertEquals(keys[2], `${generateKey("a")}-2`);
  });

  await t.step("generates stable keys for different children", () => {
    const children = ["a", "b", "c"];
    const keys = generateChildKeys(children);

    assertEquals(keys.length, 3);
    assertEquals(new Set(keys).size, 3);
  });

  await t.step("handles mixed types", () => {
    const children = ["text", 42, { type: "vnode", name: "div" }];
    const keys = generateChildKeys(children);

    assertEquals(keys.length, 3);
    assertEquals(new Set(keys).size, 3);
  });

  await t.step("handles empty array", () => {
    const keys = generateChildKeys([]);
    assertEquals(keys, []);
  });

  await t.step("handles single child", () => {
    const keys = generateChildKeys(["only"]);
    assertEquals(keys.length, 1);
    assertEquals(keys[0], `${generateKey("only")}-0`);
  });
});

Deno.test("keying - keysMatch", async (t) => {
  await t.step("returns true for matching keys", () => {
    assertEquals(keysMatch("foo-0", "foo-0"), true);
  });

  await t.step("returns false for non-matching keys", () => {
    assertEquals(keysMatch("foo-0", "foo-1"), false);
    assertEquals(keysMatch("foo", "bar"), false);
  });
});
