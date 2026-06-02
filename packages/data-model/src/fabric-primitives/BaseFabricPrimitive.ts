import { FabricPrimitive } from "../interface.ts";

/**
 * Abstract base class providing shared scaffolding for `FabricPrimitive`
 * subclasses. Concrete `FabricPrimitive` classes are intended to extend this,
 * not `FabricPrimitive` directly: `FabricPrimitive` is the pure abstract
 * contract that external code is written against, while `BaseFabricPrimitive`
 * is where shared implementation will live (mirroring the
 * `BaseFabricInstance` / `FabricInstance` split).
 *
 * It is currently empty -- a placeholder for that shared machinery, which lands
 * in a later change.
 */
export abstract class BaseFabricPrimitive extends FabricPrimitive {
}
