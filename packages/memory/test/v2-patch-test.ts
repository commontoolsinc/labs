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
