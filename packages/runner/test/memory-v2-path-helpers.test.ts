import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
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
