import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { applyPatch } from "../v2/patch.ts";
import { FabricError } from "@commonfabric/data-model/fabric-native-instances";
import { FabricInstance } from "@commonfabric/data-model/interface";
import { FabricBytes } from "@commonfabric/data-model/FabricBytes";
import { FabricEpochNsec } from "@commonfabric/data-model/fabric-epoch";

// `patch.ts` deep-clones incoming op values for isolation. It MUST preserve
// fabric wrapper classes: it previously used `structuredClone()`, which
// silently demotes class instances to plain objects, so a `FabricError`
// (or any `FabricInstance`/`FabricPrimitive`) round-tripped through a patch
// op came back as a plain object and was then serialized lossily (PR #3613).
// These tests pin the property directly at the `patch.ts` layer, exercising
// every op that clones a value (`replace`, `add`, `splice`, and the
// `add`-via-`move` path), plus a second `applyPatch` pass to mimic the
// engine replaying a stored patch sequence over an already-deep-frozen base.

Deno.test("memory v2 patch preserves `FabricInstance` values with full fidelity", () => {
  const placements = [
    () =>
      applyPatch({ a: { x: 1 } }, [
        {
          op: "replace",
          path: "/a",
          value: FabricError.fromNativeError(new Error("boom")),
        },
      ]) as { a: unknown },
    () =>
      applyPatch({}, [
        {
          op: "add",
          path: "/a",
          value: FabricError.fromNativeError(new Error("boom")),
        },
      ]) as { a: unknown },
    () =>
      applyPatch({ a: ["keep"] }, [
        {
          op: "splice",
          path: "/a",
          index: 1,
          remove: 0,
          add: [FabricError.fromNativeError(new Error("boom"))],
        },
      ]) as { a: unknown[] },
  ];
  const reads: Array<(r: any) => unknown> = [
    (r) => r.a,
    (r) => r.a,
    (r) => r.a[1],
  ];

  placements.forEach((place, i) => {
    const out = reads[i]!(place()) as FabricError;
    assert(out instanceof FabricError, `placement ${i}: not a FabricError`);
    assertEquals(out.message, "boom");
    assertEquals(typeof out.stack, "string");
  });
});

Deno.test("memory v2 patch keeps `FabricInstance` values as `FabricInstance`s (not demoted to plain objects)", () => {
  const patched = applyPatch({}, [
    {
      op: "add",
      path: "/e",
      value: FabricError.fromNativeError(new Error("boom")),
    },
  ]) as { e: unknown };
  const out = patched.e;

  // The structuredClone-regression guard: a demoted value would be a plain
  // object (`Object.prototype`), failing every check below.
  assert(out instanceof FabricInstance);
  assert(out instanceof FabricError);
  assertEquals(Object.getPrototypeOf(out) === Object.prototype, false);
});

Deno.test("memory v2 patch round-trips `FabricInstance` values across replayed patch passes", () => {
  const first = applyPatch({ box: {} }, [
    {
      op: "add",
      path: "/box/err",
      value: FabricError.fromNativeError(new Error("boom")),
    },
  ]);
  // `first` is deep-frozen by applyPatch; a second pass mimics the engine
  // replaying a stored patch sequence (here `move` -> `add`-clones the
  // already-deep-frozen FabricInstance).
  const second = applyPatch(first, [
    { op: "move", from: "/box/err", path: "/moved" },
  ]) as { moved: unknown };
  const out = second.moved as FabricError;

  assert(out instanceof FabricError);
  assertEquals(out.message, "boom");
  assertEquals(typeof out.stack, "string");
});

Deno.test("memory v2 patch preserves `FabricPrimitive` values with full fidelity", () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const patchedBytes = applyPatch({ a: ["keep"] }, [
    {
      op: "splice",
      path: "/a",
      index: 0,
      remove: 0,
      add: [new FabricBytes(bytes)],
    },
  ]) as { a: unknown[] };
  const outBytes = patchedBytes.a[0] as FabricBytes;
  assert(outBytes instanceof FabricBytes);
  assertEquals(outBytes.length, 4);
  assertEquals([...outBytes.slice()], [1, 2, 3, 4]);

  const patchedEpoch = applyPatch({}, [
    { op: "add", path: "/ts", value: new FabricEpochNsec(1_234n) },
  ]) as { ts: unknown };
  const outEpoch = patchedEpoch.ts as FabricEpochNsec;
  assert(outEpoch instanceof FabricEpochNsec);
  assertEquals(outEpoch.value, 1_234n);
});

Deno.test("memory v2 patch keeps `FabricPrimitive` values as `FabricPrimitive`s (not demoted to plain objects)", () => {
  const patched = applyPatch({}, [
    { op: "add", path: "/b", value: new FabricBytes(new Uint8Array([9, 9])) },
  ]) as { b: unknown };
  const out = patched.b;

  assert(out instanceof FabricBytes);
  assertEquals(Object.getPrototypeOf(out) === Object.prototype, false);
  // structuredClone would have dropped the private `#bytes` entirely.
  assertEquals((out as FabricBytes).length, 2);
});

Deno.test("memory v2 patch round-trips `FabricPrimitive` values across replayed patch passes", () => {
  const first = applyPatch({ box: {} }, [
    {
      op: "add",
      path: "/box/b",
      value: new FabricBytes(new Uint8Array([7, 8, 9])),
    },
  ]);
  const second = applyPatch(first, [
    { op: "move", from: "/box/b", path: "/moved" },
  ]) as { moved: unknown };
  const out = second.moved as FabricBytes;

  assert(out instanceof FabricBytes);
  assertEquals([...out.slice()], [7, 8, 9]);
});

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

Deno.test("memory v2 patch reuses unchanged branches across sibling updates", () => {
  const original = {
    left: {
      stable: {
        deep: true,
      },
    },
    right: {
      count: 0,
    },
  };

  const patched = applyPatch(original, [
    { op: "replace", path: "/right/count", value: 1 },
  ]) as typeof original;

  assertStrictEquals(patched.left, original.left);
  assertEquals(patched, {
    left: {
      stable: {
        deep: true,
      },
    },
    right: {
      count: 1,
    },
  });
});
