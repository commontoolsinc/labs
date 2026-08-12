/**
 * This directory holds the codec system's active machinery: the registry that
 * indexes codecs, the lookup that finds a class's codec, the abstract bases
 * every participating class extends, and the `ExplicitTagValue` family. It is
 * also the package's public face for the codec system as a whole, re-exporting
 * the declarations in `codec-interface/` so that an outside caller has one
 * entry point rather than two.
 *
 * That convenience is for this barrel alone. A module inside the package
 * imports the file it wants directly -- nothing here imports this barrel --
 * which is what keeps a module that only needs to name a codec from pulling
 * the machinery in behind it, and is the point of the two directories.
 *
 * Everything here is format-agnostic. Nothing in this directory knows which
 * wire format is in play, and a codec that exists because one particular
 * format cannot carry some type belongs with that format instead:
 * `codec-json/` holds the four that JSON needs.
 *
 * The classes here are the codec system's own. That covers the two abstract
 * bases every participating class extends, and the `ExplicitTagValue` family,
 * whose members exist only because a decode went wrong or found a tag that no
 * codec claimed. A class a caller models data with belongs in
 * `fabric-instances/` or `fabric-primitives/` instead.
 */
export * from "@/codec-interface/index.ts";

export { codecOf } from "./codecOf.ts";
export { CodecRegistry } from "./CodecRegistry.ts";

export { BaseFabricInstance } from "./BaseFabricInstance.ts";
export { BaseFabricPrimitive } from "./BaseFabricPrimitive.ts";
export { ExplicitTagValue } from "./ExplicitTagValue.ts";
export { ProblematicValue } from "./ProblematicValue.ts";
export { UnknownValue } from "./UnknownValue.ts";
