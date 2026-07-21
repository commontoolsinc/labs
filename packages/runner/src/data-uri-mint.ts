/**
 * The mint half of the `data:` cell URI codec, in a leaf module: its only
 * dependencies are `data-model` and a type import, so graph-heavy modules
 * (notably `runtime.ts`) can mint without importing the link machinery that
 * the rest of the codec (`data-uri.ts`) needs.
 */

import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { jsonFromValue } from "@commonfabric/data-model/codec-json";
import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";
import type { URI } from "@commonfabric/memory/interface";

/** The media type minted for `data:` cell URIs. */
export const DATA_URI_MEDIA_TYPE = "application/vnd.common-fabric.data";

/**
 * Is `mediaType` the `data:` cell URI media type? Exactly one type is
 * accepted; there are no parameters (the payload is always base64url of
 * UTF-8 text, so none are needed).
 */
export function isDataURIMediaType(mediaType: string): boolean {
  return mediaType === DATA_URI_MEDIA_TYPE;
}

/**
 * Does `id` look like a `data:` cell URI? (Prefix check only; the payload
 * is not validated.)
 */
export function isDataURI(id: string): boolean {
  return id.startsWith(`data:${DATA_URI_MEDIA_TYPE}`);
}

/**
 * Assembles a `data:` cell URI carrying (the encoding of) `value` -- the
 * single place the URI shape is put together: scheme, media type, and the
 * base64url-of-UTF-8 `fvj1:` payload. Unlike
 * `data-uri.ts`'s `createDataCellURI()`, this does no link rewriting or
 * other preparation of `value`; callers hand it a ready `FabricValue`.
 */
export function mintDataCellURI(value: FabricValue): URI {
  const payload = toUnpaddedBase64url(
    new TextEncoder().encode(jsonFromValue(value)),
  );
  return `data:${DATA_URI_MEDIA_TYPE},${payload}` as URI;
}
