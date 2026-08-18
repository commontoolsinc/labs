/**
 * This directory holds the abstract base classes that a concrete fabric value
 * extends: `BaseFabricInstance` for one branch of the type hierarchy,
 * `BaseFabricPrimitive` for the other. Each carries the static guard enforcing
 * that its branch is in fact reached through it, and a custom inspector so
 * that a value whose whole state is private fields still renders as what it
 * is. `BaseFabricInstance` additionally carries the clone template methods and
 * the symbol-keyed freeze protocol that the generic utilities dispatch
 * through.
 *
 * These are the implementer's half of the value hierarchy, and `interface.ts`
 * is the client's. Code that merely uses fabric values is written against the
 * abstract contracts there -- `FabricSpecialObject`, `FabricInstance`,
 * `FabricPrimitive` -- and importing that module deliberately does not reach
 * these classes. Extending one of these is what adding a new kind of value to
 * the data model takes, which is a different job with a different audience.
 *
 * Nothing here knows about codecs or wire formats. A value class binds its own
 * codec, and the machinery driving those lives in `codec-common/`.
 */

export { BaseFabricInstance } from "./BaseFabricInstance.ts";
export { BaseFabricPrimitive } from "./BaseFabricPrimitive.ts";
