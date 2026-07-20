/**
 * The mint half of the `data:` cell URI codec, in a leaf module: its only
 * dependencies are `data-model` and a type import, so graph-heavy modules
 * (notably `runtime.ts`) can mint without importing the link machinery that
 * the rest of the codec (`data-uri.ts`) needs.
 */

import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { jsonFromValue } from "@commonfabric/data-model/codec-json";
import type { URI } from "@commonfabric/memory/interface";

/** The media type minted for `data:` cell URIs. */
export const DATA_CELL_MEDIA_TYPE = "application/vnd.common-fabric.data";

/**
 * Also-accepted media type for `data:` cell URIs: read, never minted here.
 * Ids in this form can arrive from external minters and from processes
 * running earlier builds.
 */
const LEGACY_DATA_CELL_MEDIA_TYPE = "application/json";

/**
 * Is `mediaType` one of the accepted `data:` cell URI media types?
 */
export function isDataCellMediaType(mediaType: string): boolean {
  return mediaType === DATA_CELL_MEDIA_TYPE ||
    mediaType === LEGACY_DATA_CELL_MEDIA_TYPE;
}

/**
 * Does `id` look like a `data:` cell URI, in either accepted media type?
 * (Prefix check only; header parameters and payload are not validated.)
 */
export function isDataCellURI(id: string): boolean {
  return id.startsWith(`data:${DATA_CELL_MEDIA_TYPE}`) ||
    id.startsWith(`data:${LEGACY_DATA_CELL_MEDIA_TYPE}`);
}

/**
 * Assembles a `data:` cell URI carrying (the encoding of) `value` -- the
 * single place the URI shape is put together: scheme, media type, and the
 * percent-encoded (UTF-8-safe) `fvj1:` payload. Unlike
 * `data-uri.ts`'s `createDataCellURI()`, this does no link rewriting or
 * other preparation of `value`; callers hand it a ready `FabricValue`.
 */
export function mintDataCellURI(value: FabricValue): URI {
  return `data:${DATA_CELL_MEDIA_TYPE},${
    encodeURIComponent(jsonFromValue(value))
  }` as URI;
}
