import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  deepFreeze,
  type FabricContainerValue,
  type FabricValue,
  forEachFabricContainerValue,
} from "@commonfabric/data-model";
import { UnknownValue } from "@commonfabric/data-model/codec-common";

describe("forEachFabricContainerValue", () => {
  it("visits shared containers once, including instance codec state", () => {
    const child = deepFreeze({ count: 1 });
    const state = deepFreeze({ child });
    const instance = new UnknownValue("TraversalFixture@1", state);
    const root = { left: child, right: child, instance };
    const visited: FabricContainerValue[] = [];
    forEachFabricContainerValue(root, (value) => visited.push(value));
    expect(visited.filter((value) => value === child)).toHaveLength(1);
    expect(visited).toContain(instance);
    expect(visited).toContain(state);
    expect(Object.isFrozen(root)).toBe(false);
  });

  it("rejects cycles without mutating the graph", () => {
    const value: Record<string, FabricValue> = {};
    value.self = value;
    expect(() => forEachFabricContainerValue(value, () => {})).toThrow(
      /cyclic/,
    );
    expect(value.self).toBe(value);
    expect(Object.isFrozen(value)).toBe(false);
  });
});
