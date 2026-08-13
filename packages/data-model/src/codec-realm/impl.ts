import { RealmCodecEngine } from "./RealmCodecEngine.ts";

/**
 * Indicates if the given value has a "first-blush" appearance as a value in
 * the realm-crossing encoding that `RealmCodecEngine` defines, by looking for
 * its format-identifying envelope.
 */
export function seemsLikeRealmEncodedFabricValue(value: unknown): boolean {
  return RealmCodecEngine.seemsLikeEncoded(value);
}
