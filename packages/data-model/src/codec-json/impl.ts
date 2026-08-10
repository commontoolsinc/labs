import { JsonCodec } from "./JsonCodec.ts";

/**
 * Indicates if the given text has a "first-blush" appearance as text in the
 * JSON-embedded encoding that `JsonCodec` defines, by looking for its
 * format-identifying prefix tag.
 */
export function seemsLikeJsonEncodedFabricValue(value: string): boolean {
  return JsonCodec.seemsLikeEncoded(value);
}
