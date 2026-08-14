/**
 * This directory holds the codec system's active machinery: the registry that
 * indexes codecs, the lookup that finds a class's codec, the abstract bases
 * described below, and the `ExplicitTagValue` family. It is also the package's
 * public face for the codec system as a whole, re-exporting the declarations
 * in `codec-interface/` so that an outside caller has one entry point rather
 * than two.
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
 * Two kinds of abstract base live here, and counting them together is a
 * mistake: nothing extends one kind and the other. `BaseFabricInstance` and
 * `BaseFabricPrimitive` are what a VALUE extends in order to participate in a
 * wire format at all, one per branch of the fabric type hierarchy.
 * `BaseCodecEngine` is what an ENGINE extends, one per wire format -- the
 * thing that walks such values and drives their codecs.
 *
 * Besides those, the classes here are the `ExplicitTagValue` family, whose
 * members exist only because a decode went wrong or found a tag that no codec
 * claimed. A class a caller models data with belongs in `fabric-instances/`
 * or `fabric-primitives/` instead.
 */

export * from "@/codec-interface/index.ts";

export { codecOf } from "./codecOf.ts";
export { isCodecTypeTag } from "./isCodecTypeTag.ts";
export { CodecRegistry } from "./CodecRegistry.ts";
export { BaseCodecEngine } from "./BaseCodecEngine.ts";

export { BaseFabricInstance } from "./BaseFabricInstance.ts";
export { BaseFabricPrimitive } from "./BaseFabricPrimitive.ts";
export { ExplicitTagValue } from "./ExplicitTagValue.ts";
export { ProblematicStateError } from "./ProblematicStateError.ts";
export { ProblematicValue } from "./ProblematicValue.ts";
export { toReportableState } from "./toReportableState.ts";
export { UnknownValue } from "./UnknownValue.ts";
