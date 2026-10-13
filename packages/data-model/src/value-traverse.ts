/** Read-only traversal of Fabric containers, including instance codec state. */

import type { FabricContainerValue, FabricValue } from "./interface.ts";
import {
  DefaultValueVisitor,
  DO_RECURSE_VALUES,
  type VisitResult,
  visitValue,
} from "./value-visit/index.ts";

/** Defers initialization until codec and visitor modules finish loading. */
let visitorClass:
  | (new (
    callback: (value: FabricContainerValue) => void,
  ) => DefaultValueVisitor)
  | undefined;

/**
 * Calls `callback` once per container identity in a Fabric graph, including
 * containers in instance codec state. Input must remain unchanged during the
 * walk. Shared subtrees are visited once; reference cycles are rejected.
 */
export function forEachFabricContainerValue(
  value: FabricValue,
  callback: (value: FabricContainerValue) => void,
): void {
  visitorClass ??= class ContainerVisitor extends DefaultValueVisitor {
    readonly #seen = new WeakSet<object>();
    readonly #callback: (value: FabricContainerValue) => void;

    constructor(callback: (value: FabricContainerValue) => void) {
      super();
      this.#callback = callback;
    }

    override visitFabricContainerValue(
      value: FabricContainerValue,
    ): VisitResult<never, FabricValue> {
      if (this.#seen.has(value)) return { type: "mapTo", value };
      this.#seen.add(value);
      this.#callback(value);
      return DO_RECURSE_VALUES;
    }

    override visitPrimitiveValue(): undefined {
      return undefined;
    }

    override visitCycle(): never {
      throw new Error("Cannot traverse a cyclic Fabric value");
    }

    static {
      Object.freeze(this);
      Object.freeze(this.prototype);
    }
  };
  visitValue(value, new visitorClass(callback));
}
