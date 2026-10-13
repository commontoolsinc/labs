/** Read-only traversal of Fabric containers, including instance codec state. */

import type { FabricContainerValue, FabricValue } from "./interface.ts";
import {
  DefaultValueVisitor,
  DO_RECURSE_VALUES,
  type VisitResult,
  visitValue,
} from "./value-visit/index.ts";

/**
 * Calls `callback` once per container identity in a Fabric graph, including
 * containers in instance codec state. Input must remain unchanged during the
 * walk. Shared subtrees are visited once; reference cycles are rejected unless
 * `allowCycles` is set, in which case each identity is still visited only once.
 */
export function forEachFabricContainerValue(
  value: FabricValue,
  callback: (value: FabricContainerValue) => void,
  options: { allowCycles?: boolean } = {},
): void {
  visitValue(
    value,
    new ContainerVisitor(callback, options.allowCycles === true),
  );
}

class ContainerVisitor extends DefaultValueVisitor {
  readonly #seen = new WeakSet<object>();
  readonly #callback: (value: FabricContainerValue) => void;
  readonly #allowCycles: boolean;

  constructor(
    callback: (value: FabricContainerValue) => void,
    allowCycles: boolean,
  ) {
    super();
    this.#callback = callback;
    this.#allowCycles = allowCycles;
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

  override visitCycle(
    value: FabricContainerValue,
  ): VisitResult<never, FabricValue> {
    if (this.#allowCycles) return { type: "mapTo", value };
    throw new Error("Cannot traverse a cyclic Fabric value");
  }

  static {
    Object.freeze(this);
    Object.freeze(this.prototype);
  }
}
