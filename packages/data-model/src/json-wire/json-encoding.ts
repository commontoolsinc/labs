import { isInstance } from "@commonfabric/utils/types";
import type { FabricValue } from "../fabric-value.ts";
import type { ReconstructionContext } from "../fabric-value.ts";
import { EmptyReconstructionContext } from "../EmptyReconstructionContext.ts";
import { JsonEncodingContext } from "./JsonEncodingContext.ts";

/** Shared JSON encoding context. */
const jsonEncodingContext = new JsonEncodingContext();

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
  return jsonEncodingContext.encode(value);
}

/**
 * Decodes a string in the `FabricValue` JSON-embedded encoding format, which is
 * expected to be a plain object. Throws if it turns out to be something else.
 * If `runtime` is omitted, a shared decode-framed empty context is
 * substituted (via `valueFromJson()`), which throws if any reconstruction
 * is needed.
 */
export function plainObjectFromJson<T extends object = object>(
  json: string,
  runtime?: ReconstructionContext,
): T {
  const result = valueFromJson(json, runtime);

  if ((result === null) || (typeof result !== "object")) {
    throw new Error(
      "plainObjectFromJson: Decoded to primitive (not a plain object)",
    );
  } else if (Array.isArray(result)) {
    throw new Error(
      "plainObjectFromJson: Decoded to array (not a plain object)",
    );
  } else if (isInstance(result)) {
    throw new Error(
      "plainObjectFromJson: Decoded to instance (not a plain object)",
    );
  }

  return result as T;
}

/**
 * Indicates if the given text has a "first-blush" appearance as valid encoded
 * JSON as defined by this module.
 */
export function seemsLikeJsonEncodedFabricValue(value: string): boolean {
  return JsonEncodingContext.seemsLikeEncoded(value);
}

/**
 * Decodes a string in the `FabricValue` JSON-embedded encoding format. If
 * `runtime` is omitted, the shared decode-framed empty context
 * (`JSON_DECODE_EMPTY_CONTEXT`) is substituted, which throws if any
 * reconstruction is needed.
 */
export function valueFromJson(
  json: string,
  runtime?: ReconstructionContext | undefined,
): FabricValue {
  return jsonEncodingContext.decode(
    json,
    runtime ?? JSON_DECODE_EMPTY_CONTEXT,
  );
}
