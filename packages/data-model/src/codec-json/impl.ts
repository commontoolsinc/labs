import { JsonCodecEngine } from "./JsonCodecEngine.ts";

/**
 * Indicates if the given text has a "first-blush" appearance as text in the
 * JSON-embedded encoding that `JsonCodecEngine` defines, by looking for its
 * format-identifying prefix tag.
 */
export function seemsLikeJsonEncodedFabricValue(value: string): boolean {
  return JsonCodecEngine.seemsLikeEncoded(value);
}
