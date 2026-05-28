import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { deepFreeze, isDeepFrozen } from "@commonfabric/data-model/deep-freeze";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import type { FabricValue } from "@commonfabric/memory/interface";
import type { EntityDocument } from "@commonfabric/memory/v2";
import {
  cloneWithoutPath,
  cloneWithValueAtPath,
  hasValueAtPath,
  readValueAtPath,
} from "../src/storage/v2-path.ts";

describe("memory v2 path helpers", () => {
  it("ignores inherited object properties during traversal", () => {
    const root = Object.create({
      inherited: 7,
    }) as Record<string, unknown>;

    expect(hasValueAtPath(root as FabricValue, ["inherited"])).toBe(false);
    expect(readValueAtPath(root as FabricValue, ["inherited"])).toBeUndefined();
  });

  it("ignores inherited array indices during traversal", () => {
    const prototype = ["ghost"];
    const root: unknown[] = [];
    Object.setPrototypeOf(root, prototype);

    expect(hasValueAtPath(root as FabricValue, ["0"])).toBe(false);
    expect(readValueAtPath(root as FabricValue, ["0"])).toBeUndefined();
  });

  it("cloneWithValueAtPath only copies mutated ancestors", () => {
    const root: EntityDocument = {
      value: {
        left: {
          nested: { stable: true },
        },
        right: {
          count: 1,
        },
      },
    };

    const result = cloneWithValueAtPath(root, ["value", "right", "count"], 2)!;

    expect(result).not.toBe(root);
    expect(result.value).not.toBe(root.value);
    expect((result.value as Record<string, unknown>).left).toBe(
      (root.value as Record<string, unknown>).left,
    );
    expect((result.value as Record<string, unknown>).right).not.toBe(
      (root.value as Record<string, unknown>).right,
    );
    expect(root).toEqual({
      value: {
        left: {
          nested: { stable: true },
        },
        right: {
          count: 1,
        },
      },
    });
    expect(result).toEqual({
      value: {
        left: {
          nested: { stable: true },
        },
        right: {
          count: 2,
        },
      },
    });
  });

  it("cloneWithoutPath only copies mutated ancestors", () => {
    const root: EntityDocument = {
      value: {
        left: {
          nested: { stable: true },
        },
        right: {
          keep: 1,
          remove: 2,
        },
      },
    };

    const result = cloneWithoutPath(root, ["value", "right", "remove"])!;

    expect(result).not.toBe(root);
    expect(result.value).not.toBe(root.value);
    expect((result.value as Record<string, unknown>).left).toBe(
      (root.value as Record<string, unknown>).left,
    );
    expect((result.value as Record<string, unknown>).right).not.toBe(
      (root.value as Record<string, unknown>).right,
    );
    expect(root).toEqual({
      value: {
        left: {
          nested: { stable: true },
        },
        right: {
          keep: 1,
          remove: 2,
        },
      },
    });
    expect(result).toEqual({
      value: {
        left: {
          nested: { stable: true },
        },
        right: {
          keep: 1,
        },
      },
    });
  });

  it("cloneWithoutPath returns the original root for no-op deletes", () => {
    const root: EntityDocument = {
      value: {
        left: {
          stable: true,
        },
      },
    };

    expect(cloneWithoutPath(root, ["value", "right"])).toBe(root);
    expect(cloneWithoutPath(root, ["value", "left", "missing"])).toBe(root);
  });
});

describe("memory v2 path helpers — deep-freeze contract", () => {
  it("cloneWithValueAtPath returns a deep-frozen result for path writes", () => {
    const root: EntityDocument = {
      value: {
        left: { nested: { stable: true } },
        right: { count: 1 },
      },
    };

    const result = cloneWithValueAtPath(
      root,
      ["value", "right", "count"],
      2,
    )!;

    expect(isDeepFrozen(result)).toBe(true);
  });

  it("cloneWithValueAtPath returns a deep-frozen result for empty-path writes", () => {
    const replacement: FabricValue = { value: { a: 1, b: [2, 3] } };

    const result = cloneWithValueAtPath(undefined, [], replacement)!;

    expect(isDeepFrozen(result)).toBe(true);
  });

  it("cloneWithoutPath returns a deep-frozen result for path deletes", () => {
    const root: EntityDocument = {
      value: {
        left: { nested: { stable: true } },
        right: { keep: 1, remove: 2 },
      },
    };

    const result = cloneWithoutPath(root, ["value", "right", "remove"])!;

    expect(isDeepFrozen(result)).toBe(true);
  });
});

// These helpers shallow-clone each container along the mutated spine. The
// clone must preserve the *class* of whatever it copies: a Fabric wrapper
// (`FabricInstance` / `FabricPrimitive`) traversed on the spine must come out
// intact, not demoted to a prototype-shaped husk. The pre-dedup
// implementation used `Object.create(getPrototypeOf(v)) + Object.assign(v)`,
// which copies only enumerable own data properties -- so a wrapper whose
// state lives in private fields (and whose accessors are prototype getters)
// became a hollow husk: its getters threw `Cannot read private member`, and
// for `FabricError` even `deepFreeze()` threw. Delegating to
// `cloneIfNecessary` routes wrappers through their own `shallowClone()` /
// immutable-passthrough, preserving identity and content.
describe("memory v2 path helpers — Fabric wrapper preservation on spine", () => {
  it("cloneWithValueAtPath preserves a FabricError traversed on the spine", () => {
    const native = new Error("boom");
    (native as unknown as Record<string, unknown>).code = "E42";
    const wrapper = deepFreeze(FabricError.fromNativeError(native));
    const root = deepFreeze({
      value: { wrapper },
    }) as unknown as EntityDocument;

    // Descends through `wrapper`, so it is shallow-cloned on the spine.
    const result = cloneWithValueAtPath(
      root,
      ["value", "wrapper", "added"],
      1,
    )!;

    const out = (result.value as Record<string, unknown>)
      .wrapper as FabricError;
    expect(out).toBeInstanceOf(FabricError);
    // Content survives: pre-dedup this threw inside `deepFreeze()` because the
    // husk's private `#extras` was absent.
    expect(out.getExtra("code")).toBe("E42");
    expect(out.message).toBe("boom");
  });

  // Prophylactic (does not fail pre-dedup): a `FabricPrimitive` is opaque, so
  // it can only ever be an off-spine *sibling* within a shallow-cloned spine
  // container, never a traversed-through spine node itself (it has no
  // traversable members). This pins that a getter-backed primitive
  // (`FabricHash` exposes all state via prototype getters over private fields
  // -- exactly the shape `Object.assign` would hollow out) survives a spine
  // shallow-clone by identity, guarding against a future clone change that
  // deep-copies or class-demotes nested wrappers.
  it("cloneWithValueAtPath preserves a FabricHash sibling of the mutated spine", () => {
    const hash = FabricHash.fromString("sha256:abcd");
    const root = deepFreeze({
      value: { keep: hash, target: { count: 1 } },
    }) as unknown as EntityDocument;

    // `value` is shallow-cloned (it's on the spine to `target.count`); its
    // `keep` sibling must ride along by identity, not be reconstructed.
    const result = cloneWithValueAtPath(
      root,
      ["value", "target", "count"],
      2,
    )!;

    const out = (result.value as Record<string, unknown>).keep as FabricHash;
    expect(out).toBe(hash);
    expect(out).toBeInstanceOf(FabricHash);
    expect(out.tag).toBe("sha256");
    expect(out.taggedHashString).toBe("sha256:abcd");
  });
});
