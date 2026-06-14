import { FabricPrimitive } from "@/interface.ts";

/**
 * Abstract base class for `FabricPrimitive` subclasses. Concrete
 * `FabricPrimitive` classes extend this, not `FabricPrimitive` directly:
 * `FabricPrimitive` is the pure abstract contract that external code is written
 * against, while `BaseFabricPrimitive` is the designated home for shared
 * implementation. It currently adds no members of its own (its counterpart
 * `BaseFabricInstance` carries the `shallowClone()` template method).
 */
export abstract class BaseFabricPrimitive extends FabricPrimitive {
}
