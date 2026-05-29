import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { shallowMutableDeepFrozenClone } from "../src/fabric-value.ts";
import { deepFreeze, isDeepFrozen } from "../src/deep-freeze.ts";
import { FabricBytes } from "../src/fabric-primitives/FabricBytes.ts";
import { FabricHash } from "../src/fabric-primitives/FabricHash.ts";
import { FabricError } from "../src/fabric-instances/FabricError.ts";

// `shallowMutableDeepFrozenClone(v)` returns a fresh mutable top-level copy
// whose bound children are guaranteed deep-frozen: already-deep-frozen children
// are identity-passed (zero-copy), while mutable children are
// deep-cloned-and-frozen without touching the input. The headline guarantee is
// that a single `Object.freeze()` on the result yields a fully-deep-frozen
// value.
describe("shallowMutableDeepFrozenClone", () => {
  it("returns a fresh, mutable, top-level object copy", () => {
    const input = deepFreeze({ a: 1, b: 2 });
    const out = shallowMutableDeepFrozenClone(input);

    expect(out).not.toBe(input);
    expect(out).toEqual({ a: 1, b: 2 });
    expect(Object.isFrozen(out)).toBe(false);
    // Mutable: can be written in place (the spine-write use case).
    (out as Record<string, number>).a = 99;
    expect((out as Record<string, number>).a).toBe(99);
    // Input is untouched.
    expect((input as Record<string, number>).a).toBe(1);
  });

  it("returns a fresh, mutable, top-level array copy", () => {
    const input = deepFreeze([1, 2, 3]);
    const out = shallowMutableDeepFrozenClone(input);

    expect(out).not.toBe(input);
    expect(out).toEqual([1, 2, 3]);
    expect(Object.isFrozen(out)).toBe(false);
  });

  it("identity-passes already-deep-frozen children (zero-copy)", () => {
    const child = deepFreeze({ nested: true });
    const input = { child };
    const out = shallowMutableDeepFrozenClone(input) as Record<string, unknown>;

    expect(Object.isFrozen(out)).toBe(false);
    expect(out.child).toBe(child);
  });

  it("deep-freezes mutable children by cloning, leaving the input untouched", () => {
    const child = { nested: true };
    const input = { child };
    const out = shallowMutableDeepFrozenClone(input) as Record<
      string,
      typeof child
    >;

    // Top stays mutable; the child is now deep-frozen...
    expect(Object.isFrozen(out)).toBe(false);
    expect(Object.isFrozen(out.child)).toBe(true);
    expect(out.child).toEqual({ nested: true });
    // ...but it's a clone, so the caller's input is not frozen in place.
    expect(out.child).not.toBe(child);
    expect(Object.isFrozen(child)).toBe(false);
  });

  it("yields a fully deep-frozen value after a single top-level freeze", () => {
    // The headline use case: mutate the top, then deep-freeze the whole.
    const input = { a: { b: 1 }, c: [1, 2, { d: 3 }] };
    const out = shallowMutableDeepFrozenClone(input);

    Object.freeze(out);
    expect(isDeepFrozen(out)).toBe(true);
  });

  it("always copies, even an already-mutable input (force)", () => {
    const input = { a: 1 };
    const out = shallowMutableDeepFrozenClone(input as Record<string, number>);

    expect(out).not.toBe(input);
  });

  it("preserves a `FabricInstance` class and content (not a husk)", () => {
    const native = new Error("boom");
    (native as unknown as Record<string, unknown>).code = "E42";
    const input = deepFreeze(FabricError.fromNativeError(native));

    const out = shallowMutableDeepFrozenClone(input);

    expect(out).toBeInstanceOf(FabricError);
    expect(out.getExtra("code")).toBe("E42");
    expect(out.message).toBe("boom");
  });

  it("preserves getter-backed `FabricPrimitive`s by identity-passthrough", () => {
    const hash = FabricHash.fromString("sha256:abcd");
    const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));

    // Inherently immutable -- returned as-is, with state intact.
    const outHash = shallowMutableDeepFrozenClone(hash);
    expect(outHash).toBe(hash);
    expect(outHash.tag).toBe("sha256");

    const outBytes = shallowMutableDeepFrozenClone(bytes);
    expect(outBytes).toBe(bytes);
    expect(outBytes.length).toBe(3);
  });
});
