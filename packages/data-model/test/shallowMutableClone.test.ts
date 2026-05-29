import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cloneIfNecessary, shallowMutableClone } from "../src/fabric-value.ts";
import { deepFreeze } from "../src/deep-freeze.ts";
import { FabricBytes } from "../src/fabric-primitives/FabricBytes.ts";
import { FabricHash } from "../src/fabric-primitives/FabricHash.ts";
import { FabricError } from "../src/fabric-instances/FabricError.ts";

// `shallowMutableClone(v)` is a thin wrapper for
// `cloneIfNecessary(v, { frozen: false, deep: false, force: true })`, so the
// coverage here is intentionally light: it pins the wrapper's headline
// guarantees (fresh mutable top-level copy, identity-shared children,
// class-preserving) rather than re-testing `cloneIfNecessary` exhaustively.
describe("shallowMutableClone", () => {
  it("returns a fresh, mutable, top-level object copy", () => {
    const input = deepFreeze({ a: 1, b: 2 });
    const out = shallowMutableClone(input);

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
    const out = shallowMutableClone(input);

    expect(out).not.toBe(input);
    expect(out).toEqual([1, 2, 3]);
    expect(Object.isFrozen(out)).toBe(false);
  });

  it("shares children by identity (shallow, not deep)", () => {
    const child = deepFreeze({ nested: true });
    const input = deepFreeze({ child });
    const out = shallowMutableClone(input) as Record<string, unknown>;

    expect(out.child).toBe(child);
  });

  it("always copies, even an already-mutable input (force)", () => {
    const input = { a: 1 };
    const out = shallowMutableClone(input as Record<string, number>);

    expect(out).not.toBe(input);
  });

  it("preserves a `FabricInstance` class and content (not a husk)", () => {
    const native = new Error("boom");
    (native as unknown as Record<string, unknown>).code = "E42";
    const input = deepFreeze(FabricError.fromNativeError(native));

    const out = shallowMutableClone(input);

    expect(out).toBeInstanceOf(FabricError);
    expect(out.getExtra("code")).toBe("E42");
    expect(out.message).toBe("boom");
  });

  it("preserves getter-backed `FabricPrimitive`s by identity-passthrough", () => {
    const hash = FabricHash.fromString("sha256:abcd");
    const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));

    // Inherently immutable -- returned as-is, with state intact.
    const outHash = shallowMutableClone(hash);
    expect(outHash).toBe(hash);
    expect(outHash.tag).toBe("sha256");

    const outBytes = shallowMutableClone(bytes);
    expect(outBytes).toBe(bytes);
    expect(outBytes.length).toBe(3);
  });

  it("matches the equivalent `cloneIfNecessary()` options", () => {
    const input = deepFreeze({ a: { b: 1 } });
    const viaWrapper = shallowMutableClone(input) as Record<string, unknown>;
    const viaOptions = cloneIfNecessary(input, {
      frozen: false,
      deep: false,
      force: true,
    }) as Record<string, unknown>;

    // Same shallow semantics: top-level copied, child shared by identity.
    expect(viaWrapper).not.toBe(input);
    expect(viaOptions).not.toBe(input);
    expect(viaWrapper.a).toBe((input as Record<string, unknown>).a);
    expect(viaOptions.a).toBe((input as Record<string, unknown>).a);
  });
});
