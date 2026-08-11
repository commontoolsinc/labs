// The package's ready-to-use codec defaults: entry points that encode and
// decode with this package's own set of fabric classes, for callers that want
// the standard answer rather than a configured one.
//
// This sits above `codec-json` and `codec-common`, which carry the format and
// the mechanism and know nothing about which classes participate. Nothing in
// either of those directories may import from here; the dependency runs one
// way, and a convenience import in the other direction would make it a cycle.
//
// Both class rosters are imported at module scope and the registry is built at
// first import, so this module pulls in every class that participates in the
// wire format. That is the shape a cycle would be most costly in, which is the
// other half of why the rule above is absolute rather than stylistic.

import { isInstance } from "@commonfabric/utils/types";

import type { FabricValue } from "./fabric-value.ts";
import type { ReconstructionContext } from "./codec-common/interface.ts";
import { EmptyReconstructionContext } from "./codec-common/EmptyReconstructionContext.ts";
import type { CodecRegistry } from "./codec-common/CodecRegistry.ts";
import { JsonCodec } from "./codec-json/JsonCodec.ts";
import { createBaseJsonRegistry } from "./codec-json/createBaseJsonRegistry.ts";
import { jsonCodecs as primitiveJsonCodecs } from "./fabric-primitives/index.ts";
import { codecs as instanceCodecs } from "./fabric-instances/index.ts";

/**
 * Creates a registry pairing the JSON format with the fabric classes this
 * package defines. This is the registry to build on: a caller adding classes
 * of its own extends what this returns, so that it cannot omit these by
 * accident.
 *
 * The two curated `codecClasses()` lists are the source of truth for which
 * classes participate, so the wire-format surface is decided where those are
 * written rather than here. Each list is read through the symbol its classes
 * bind: a `FabricPrimitive` supplies a codec per wire format, so the JSON one
 * comes from its static `[JSON_CODEC]`; a `FabricInstance` supplies one that
 * serves every format, from its static `[CODEC]`.
 *
 * `UnknownValue` and `ProblematicValue` are among them, but their codecs
 * recognize no single wire tag: the encode path resolves an instance's tag
 * with `tagForValue()`, and an unrecognized tag on decode is wrapped in an
 * `UnknownValue` by the encoding context rather than tag-routed.
 */
export function createDefaultJsonRegistry(): CodecRegistry {
  return createBaseJsonRegistry().extend([
    ...primitiveJsonCodecs(),
    ...instanceCodecs(),
  ]);
}

/**
 * Constructs a `JsonCodec` over {@link createDefaultJsonRegistry}, for a
 * caller that wants this package's classes rather than a set of its own.
 * `options.lenient` is passed through.
 */
export function newDefaultJsonCodec(
  options?: { lenient?: boolean },
): JsonCodec {
  return new JsonCodec({
    registry: createDefaultJsonRegistry(),
    lenient: options?.lenient ?? false,
  });
}

/** Shared JSON codec. */
const jsonCodec = newDefaultJsonCodec();

/**
 * Shared empty `ReconstructionContext` used when a JSON decode is requested
 * without a runtime context. Behaviorally identical to the bare empty
 * singleton (`shouldDeepFreeze` is `true`); only the `getCell()` throw
 * message is decode-framed, so an unexpected cell reference during a
 * context-less decode produces a message that names the situation. This
 * single instance covers both public entry points (`valueFromJson()` and
 * `plainObjectFromJson()`, the latter delegating to the former).
 */
const JSON_DECODE_EMPTY_CONTEXT = Object.freeze(
  new EmptyReconstructionContext(
    true,
    "no runtime context (JSON decode); a cell reference cannot be reconstructed.",
  ),
);

/**
 * Encodes a fabric value to a JSON string in the standard `FabricValue`
 * JSON-embedded encoding, prefixed with the format-identifying tag `fvj1:`.
 */
export function jsonFromValue(value: FabricValue): string {
  return jsonCodec.encode(value);
}

/**
 * Decodes a string in the `FabricValue` JSON-embedded encoding format, which is
 * expected to be a plain object. Throws if it turns out to be something else.
 * If `context` is omitted, a shared decode-framed empty context is
 * substituted (via `valueFromJson()`), which throws if any reconstruction
 * is needed.
 */
export function plainObjectFromJson<T extends object = object>(
  json: string,
  context?: ReconstructionContext,
): T {
  const result = valueFromJson(json, context);

  if ((result === null) || (typeof result !== "object")) {
    throw new Error(
      "`plainObjectFromJson()`: decoded to a primitive, not a plain object",
    );
  } else if (Array.isArray(result)) {
    throw new Error(
      "`plainObjectFromJson()`: decoded to an array, not a plain object",
    );
  } else if (isInstance(result)) {
    throw new Error(
      "`plainObjectFromJson()`: decoded to an instance, not a plain object",
    );
  }

  return result as T;
}

/**
 * Decodes a string in the `FabricValue` JSON-embedded encoding format. If
 * `context` is omitted, the shared decode-framed empty context
 * (`JSON_DECODE_EMPTY_CONTEXT`) is substituted, which throws if any
 * reconstruction is needed.
 */
export function valueFromJson(
  json: string,
  context?: ReconstructionContext | undefined,
): FabricValue {
  return jsonCodec.decode(
    json,
    context ?? JSON_DECODE_EMPTY_CONTEXT,
  );
}
