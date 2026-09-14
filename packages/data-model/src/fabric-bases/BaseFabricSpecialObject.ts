/**
 * The runtime root of the two special-object classes, `FabricInstance` and
 * `FabricPrimitive`: the one class both extend, so that a single `instanceof`
 * recognizes either. It has no members and carries no brand. It is not a type
 * a caller names: the pattern-visible `FabricSpecialObject` in `api.ts` is the
 * union of the two subclasses, and `isFabricSpecialObject()` in
 * `type-check.ts` is the check, narrowing to that union. The data model
 * defines no other subclass, and an instance of one defined elsewhere is not a
 * `FabricValue`.
 *
 * This module imports nothing, which is what lets `interface.ts` extend the
 * two protocol classes from it while every other module keeps importing that
 * one without a cycle.
 */
export abstract class BaseFabricSpecialObject {}
