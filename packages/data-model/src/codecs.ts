/**
 * The package's ready-to-use codec defaults: entry points that encode and
 * decode with this package's own set of fabric classes, for callers that want
 * the standard answer rather than a configured one.
 *
 * This sits above `codec-json` and `codec-common`, which carry the format and
 * the mechanism and know nothing about which classes participate. Nothing in
 * either of those directories may import from here; the dependency runs one
 * way, and a convenience import in the other direction would make it a cycle.
 *
 * Both class rosters are imported at module scope and the registry is built at
 * first import, so this module pulls in every class that participates in the
 * wire format. That is the shape a cycle would be most costly in, which is the
 * other half of why the rule above is absolute rather than stylistic.
 */

import { isInstance } from "@commonfabric/utils/types";

import type { FabricValue } from "./fabric-value.ts";
import type { LiveEnvironment } from "./codec-interface/interface.ts";
import { NULL_LIVE_ENVIRONMENT } from "./codec-interface/NullLiveEnvironment.ts";
import type { CodecRegistry } from "./codec-common/CodecRegistry.ts";
import type { JsonCodecValue } from "./codec-json/interface.ts";
import { JsonCodecEngine } from "./codec-json/JsonCodecEngine.ts";
import { createBaseJsonRegistry } from "./codec-json/createBaseJsonRegistry.ts";
import { codecClasses as primitiveClasses } from "./fabric-primitives/index.ts";
import { codecClasses as instanceClasses } from "./fabric-instances/index.ts";

/**
 * Creates a registry pairing the JSON format with the fabric classes this
 * package defines. This is the registry to build on: a caller adding classes
 * of its own extends what this returns, so that it cannot omit these by
 * accident.
 *
 * The two curated `codecClasses()` lists are the source of truth for which
 * classes participate, so the wire-format surface is decided where those are
 * written rather than here. The registry reads each class's codec for itself,
 * under `[CODEC]` where a class has one and under this format's own symbol
 * otherwise, so the same two lists serve any format.
 *
 * `UnknownValue` and `ProblematicValue` are among them, but their codecs
 * recognize no single wire tag: the encode path resolves an instance's tag
 * with `tagForValue()`, and an unrecognized tag on decode is wrapped in an
 * `UnknownValue` by the encoding context rather than tag-routed.
 */
export function createDefaultJsonRegistry(): CodecRegistry<JsonCodecValue> {
  return createBaseJsonRegistry().extend(
    primitiveClasses(),
    instanceClasses(),
  );
}

/**
 * Constructs a `JsonCodecEngine` over {@link createDefaultJsonRegistry}, for a
 * caller that wants this package's classes rather than a set of its own.
 * `options.lenient` is passed through.
 */
export function newDefaultJsonCodecEngine(
  options?: { lenient?: boolean },
): JsonCodecEngine {
  return new JsonCodecEngine({
    registry: createDefaultJsonRegistry(),
    lenient: options?.lenient ?? false,
  });
}

/** Shared JSON codec. */
const jsonCodecEngine = newDefaultJsonCodecEngine();

/**
 * Encodes a fabric value to a JSON string in the standard `FabricValue`
 * JSON-embedded encoding, prefixed with the format-identifying tag `fvj1:`.
 */
export function jsonFromFabricValue(value: FabricValue): string {
  return jsonCodecEngine.encode(value);
}

/**
 * Decodes a string in the `FabricValue` JSON-embedded encoding format, which is
 * expected to be a plain object. Throws if it turns out to be something else.
 * If `context` is omitted, a shared decode-framed empty context is
 * substituted (via `fabricFromJsonValue()`), which throws if any decoding
 * is needed.
 */
export function plainObjectFromJson<T extends object = object>(
  json: string,
  context?: LiveEnvironment,
): T {
  const result = fabricFromJsonValue(json, context);

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
 * `context` is omitted, {@link NULL_LIVE_ENVIRONMENT} is substituted,
 * which throws if any decoding is needed.
 */
export function fabricFromJsonValue(
  json: string,
  context?: LiveEnvironment | undefined,
): FabricValue {
  return jsonCodecEngine.decode(json, context ?? NULL_LIVE_ENVIRONMENT);
}
