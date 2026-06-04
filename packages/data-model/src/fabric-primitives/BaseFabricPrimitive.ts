import { FabricPrimitive } from "../interface.ts";

/**
 * Abstract base class providing shared scaffolding for `FabricPrimitive`
 * subclasses. Concrete `FabricPrimitive` classes are intended to extend this,
 * not `FabricPrimitive` directly: `FabricPrimitive` is the pure abstract
 * contract that external code is written against, while `BaseFabricPrimitive`
 * is where shared implementation lives.
 */
export abstract class BaseFabricPrimitive extends FabricPrimitive {
  /**
   * The type tag to use for this instance to identify it in wire protocols
   * for which instances of this type do not have a protocol-specific form.
   */
  abstract get wireTypeTag(): string;
}
