import { FabricSpecialObject } from "./interface.ts";

/**
 * Abstract base class providing shared scaffolding for `FabricSpecialObject`
 * subtypes. Concrete fabric special-value classes are intended to extend this,
 * not `FabricSpecialObject` directly: `FabricSpecialObject` is the pure
 * abstract contract that external code is written against, while
 * `BaseFabricSpecialValue` is where shared implementation will live (mirroring
 * the `BaseFabricInstance` / `FabricInstance` split).
 *
 * It is currently empty -- a placeholder for that shared machinery, which lands
 * in a later change.
 */
export abstract class BaseFabricSpecialValue extends FabricSpecialObject {
}
