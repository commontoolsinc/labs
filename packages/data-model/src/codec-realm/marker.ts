// The one thing both an engine and a decoding act must read off an arriving
// envelope. It lives here rather than on either, so that neither has to import
// the other to reach it.

import { REALM_FORMAT_VERSION, type RealmFormatMarker } from "./interface.ts";

/**
 * The marker at slot zero of an outer envelope, or `undefined` if what is
 * there is not one this build implements.
 *
 * The one place the envelope's shape is decided, so that the context's
 * sniffing and the conversion's refusal cannot come to disagree about what
 * counts as a marker.
 */
export function markerOf(data: unknown): RealmFormatMarker | undefined {
  if (!Array.isArray(data) || (data.length !== 2)) {
    return undefined;
  }

  const marker = data[0];

  return (Array.isArray(marker) && (marker.length === 1) &&
      (marker[0] === REALM_FORMAT_VERSION))
    ? marker as unknown as RealmFormatMarker
    : undefined;
}
