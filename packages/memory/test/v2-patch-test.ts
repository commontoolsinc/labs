import { assertEquals } from "@std/assert";
import { applyPatch } from "../v2/patch.ts";

Deno.test("memory v2 patch applies multiple operations without mutating the input", () => {
  const original = {
    profile: { name: "Alice" },
    tags: ["one"],
  };

  const patched = applyPatch(original, [
    { op: "replace", path: "/profile/name", value: "Bob" },
    { op: "add", path: "/profile/title", value: "Dr" },
    {
      op: "splice",
      path: "/tags",
      index: 1,
      remove: 0,
      add: ["two", "three"],
    },
  ]);

  assertEquals(original, {
    profile: { name: "Alice" },
    tags: ["one"],
  });
  assertEquals(patched, {
    profile: { name: "Bob", title: "Dr" },
    tags: ["one", "two", "three"],
  });
});

Deno.test("memory v2 patch can replace the root and continue patching the replacement", () => {
  const original = {
    stale: true,
  };

  const patched = applyPatch(original, [
    { op: "replace", path: "", value: { items: [] } },
    { op: "add", path: "/items/-", value: "next" },
  ]);

  assertEquals(original, { stale: true });
  assertEquals(patched, { items: ["next"] });
});

Deno.test("memory v2 patch move updates the cloned document without mutating the input", () => {
  const original = {
    from: { value: 1 },
    to: {},
  };

  const patched = applyPatch(original, [
    { op: "move", from: "/from/value", path: "/to/value" },
  ]);

  assertEquals(original, {
    from: { value: 1 },
    to: {},
  });
  assertEquals(patched, {
    from: {},
    to: { value: 1 },
  });
});

Deno.test("memory v2 patch rejects moves into a descendant path", () => {
  const original = {
    a: { child: { keep: true } },
  };

  let error: Error | null = null;
  try {
    applyPatch(original, [
      { op: "move", from: "/a", path: "/a/child/moved" },
    ]);
  } catch (caught) {
    error = caught as Error;
  }

  assertEquals(error?.message, "cannot move a value into its own descendant");
  assertEquals(original, {
    a: { child: { keep: true } },
  });
});

Deno.test("memory v2 patch rejects invalid array indices", () => {
  const original = {
    items: ["a"],
  };

  for (const path of ["/items/01", "/items/4294967295"]) {
    let error: Error | null = null;
    try {
      applyPatch(original, [
        { op: "replace", path, value: "b" },
      ]);
    } catch (caught) {
      error = caught as Error;
    }

    assertEquals(error instanceof Error, true);
    assertEquals(original, {
      items: ["a"],
    });
  }
});

Deno.test("memory v2 patch rejects missing array indices in parent traversal", () => {
  const original = {
    items: [{}],
  };

  let error: Error | null = null;
  try {
    applyPatch(original, [
      { op: "add", path: "/items/1/name", value: "missing" },
    ]);
  } catch (caught) {
    error = caught as Error;
  }

  assertEquals(error?.message, "missing path /items/1/name");
  assertEquals(original, {
    items: [{}],
  });
});
