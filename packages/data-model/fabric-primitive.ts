/**
 * Abstract base class for "special primitive" fabric types -- values that
 * behave like primitives in the fabric type system but are represented as
 * class instances for type safety and dispatch. Currently covers temporal
 * types (`FabricEpochNsec`, `FabricEpochDays`) and content IDs
 * (`FabricHash`).
 *
 * Analogous to `ExplicitTagValue` (which unifies `UnknownValue` and
 * `ProblematicValue`), this class enables a single `instanceof` check
 * where code needs to handle any special primitive uniformly.
 *
 * Instances are always frozen (like true primitives, they are immutable).
 * Each leaf subclass must call `Object.freeze(this)` at the end of its
 * constructor, after all fields are initialized. (Freezing in the base
 * constructor would prevent subclass field assignment.)
 *
 * See Section 1.4.5 and 1.4.6 of the formal spec.
 */
export abstract class FabricPrimitive {
  constructor() {}
}
