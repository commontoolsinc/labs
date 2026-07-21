/**
 * The mint half of the `data:` cell URI codec, in a leaf module: its only
 * dependencies are `data-model` and a type import, so graph-heavy modules
 * (notably `runtime.ts`) can mint without importing the link machinery that
 * the rest of the codec (`data-uri.ts`) needs.
 */

import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { jsonFromValue } from "@commonfabric/data-model/codec-json";
import type { URI } from "@commonfabric/memory/interface";

/**
 * Assembles a `data:` cell URI carrying (the encoding of) `value` -- the
 * single place the URI shape is put together: scheme, media type, and the
 * percent-encoded (UTF-8-safe) `fvj1:` payload. Unlike
 * `data-uri.ts`'s `createDataCellURI()`, this does no link rewriting or
 * other preparation of `value`; callers hand it a ready `FabricValue`.
 */
export function mintDataCellURI(value: FabricValue): URI {
  return `data:application/json,${
    encodeURIComponent(jsonFromValue(value))
  }` as URI;
}
