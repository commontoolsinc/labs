/**
 * Tests for VDOM keying utilities.
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { generateChildKeys, generateKey, keysMatch } from "./keying.ts";

Deno.test("keying - generateKey", async (t) => {
  await t.step("generates stable keys for strings", () => {
    const key1 = generateKey("hello");
    const key2 = generateKey("hello");
    assertEquals(key1, key2);
    assertEquals(key1, '"hello"');
  });

  await t.step("generates stable keys for numbers", () => {
    const key1 = generateKey(42);
    const key2 = generateKey(42);
    assertEquals(key1, key2);
    assertEquals(key1, "42");
  });

  await t.step("generates stable keys for null/undefined", () => {
    assertEquals(generateKey(null), "null");
    assertEquals(generateKey(undefined), undefined); // JSON.stringify returns undefined for undefined
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
    assertEquals(generateKey(true), "true");
    assertEquals(generateKey(false), "false");
  });
});

Deno.test("keying - generateChildKeys", async (t) => {
  await t.step("generates unique keys for identical children", () => {
    const children = ["a", "a", "a"];
    const keys = generateChildKeys(children);

    assertEquals(keys.length, 3);
    // Keys should all be different
    assertEquals(new Set(keys).size, 3);
    // Keys should follow pattern with occurrence count
    assertEquals(keys[0], '"a"-0');
    assertEquals(keys[1], '"a"-1');
    assertEquals(keys[2], '"a"-2');
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
    assertEquals(keys[0], '"only"-0');
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
