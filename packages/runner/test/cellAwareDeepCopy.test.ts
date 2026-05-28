import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import { cellAwareDeepCopy } from "../src/runner-utils.ts";

describe("cellAwareDeepCopy", () => {
  it("deep-copies plain objects/arrays into a detached, mutable result", () => {
    const src = { a: 1, nested: { items: [1, 2] } };

    const copy = cellAwareDeepCopy(src);

    expect(copy).toEqual(src);
    expect(copy).not.toBe(src);
    expect(copy.nested).not.toBe(src.nested); // deep, not shallow
    expect(Object.isFrozen(copy)).toBe(false); // mutable

    src.nested.items.push(3); // detached: original mutation doesn't leak
    expect(copy.nested.items).toEqual([1, 2]);

    (copy as Record<string, unknown>).b = 2; // result is mutable
    expect((copy as Record<string, unknown>).b).toBe(2);
  });

  it("preserves a FabricPrimitive by identity rather than demoting it", () => {
    // A naive deep copy via `Object.fromEntries` would rebuild the wrapper as a
    // prototype-less `{}` husk (its state lives in private fields behind
    // getters). It must instead survive as an opaque leaf.
    const hash = FabricHash.fromString("sha256:abcd");
    const src = { meta: { hash }, list: [hash] };

    const copy = cellAwareDeepCopy(src);

    expect(copy.meta).not.toBe(src.meta); // plain spine still deep-copied
    expect(copy.meta.hash).toBe(hash); // wrapper shared by identity
    expect(copy.meta.hash).toBeInstanceOf(FabricHash);
    expect(copy.meta.hash.tag).toBe("sha256");
    expect(copy.list[0]).toBe(hash);
  });
});
