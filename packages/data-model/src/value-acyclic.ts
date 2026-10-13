/** Cycle validation for boundaries whose value encoding cannot carry cycles. */

import type { FabricContainerValue, FabricValue } from "./interface.ts";
import { isValidDeepFrozenFabricValue } from "./deep-freeze.ts";
import { isFabricContainerValue } from "./types/index.ts";
import {
  DefaultValueVisitor,
  DO_RECURSE_VALUES,
  type VisitResult,
  visitValue,
} from "./value-visit/index.ts";

/** Successfully checked frozen graphs need no subsequent walk. */
const acyclic = new WeakSet<object>();

/** The class is initialized after codec and visitor modules finish loading. */
let visitorClass: (new () => DefaultValueVisitor) | undefined;

/** Uses the shared visitor's container and codec-state cycle detection. */
function makeAcyclicVisitor(): DefaultValueVisitor {
  visitorClass ??= class AcyclicVisitor extends DefaultValueVisitor {
    readonly #seen = new WeakSet<object>();

    override visitFabricContainerValue(
      value: FabricContainerValue,
    ): VisitResult<never, FabricValue> {
      if (acyclic.has(value) || this.#seen.has(value)) {
        return { type: "mapTo", value };
      }
      this.#seen.add(value);
      return DO_RECURSE_VALUES;
    }

    override visitPrimitiveValue(): undefined {
      return undefined;
    }

    override visitCycle(): never {
      throw new Error("Cannot encode a cyclic Fabric value");
    }

    static {
      Object.freeze(this);
      Object.freeze(this.prototype);
    }
  };
  return new visitorClass();
}

/**
 * Rejects reference cycles, including cycles through instance codec state.
 * Shared subtrees are allowed. Validation never copies or freezes input;
 * successful checks of deep-frozen roots are memoized by identity.
 */
export function assertAcyclicFabricValue(value: FabricValue): void {
  if (!isFabricContainerValue(value) || acyclic.has(value)) return;
  const visitor = makeAcyclicVisitor();
  visitValue(value, visitor);
  if (isValidDeepFrozenFabricValue(value)) acyclic.add(value);
}
