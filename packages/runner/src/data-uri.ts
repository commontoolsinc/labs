/**
 * The `data:` URI codec. The runner uses `application/json` `data:` URIs as
 * self-contained content-addressed cell ids: the URI _is_ its content, so
 * reading such a cell means decoding its own id. This module holds the whole
 * matched set -- the minting side ({@link createDataCellURI}) and the reading
 * side ({@link getJSONFromDataURI} and {@link decodeDataURIPayloadText}) --
 * because the encoding chosen by the one dictates what is decodable by the
 * other, and colocating them is what keeps a change to either from drifting
 * away from its partner.
 */

import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import {
  jsonFromValue,
  seemsLikeJsonEncodedFabricValue,
  valueFromJson,
} from "@commonfabric/data-model/codec-json";
import { EmptyReconstructionContext } from "@commonfabric/data-model/codec-common";
import { isInstance, isRecord } from "@commonfabric/utils/types";
import { type Cell, isCell } from "./cell.ts";
import { isPrimitiveCellLink, type NormalizedLink } from "./link-types.ts";
import {
  createSigilLinkFromParsedLink,
  KeepAsCell,
  parseLink,
} from "./link-utils.ts";
import type { URI } from "./sigil-types.ts";

/**
 * `ReconstructionContext` for decoding `data:` URI payloads. Links at this
 * boundary are sigil (plain) data rather than cell references, so no cell
 * reconstruction is ever needed; this context exists so that an unexpected
 * cell reference produces a message that names the boundary.
 */
const dataUriReconstructionContext = new EmptyReconstructionContext(
  true,
  "no cell reconstruction at the `data:` URI boundary",
);

/**
 * Makes a `data:` URI that names a cell whose content is carried in the id
 * itself. Reading such a cell means decoding its own id; there is no document
 * in a space to fetch.
 *
 * The encoded payload is a storage document of the conventional shape
 * `{"value": <data>}`, with readers unwrapping `value` before walking a link's
 * path.
 *
 * This is the encode half of the matched set this module exists to hold;
 * {@link getJSONFromDataURI} is what reads back what this writes. This side
 * writes only the standard `data-model` `FabricValue` encoding (tagged
 * `fvj1:`); the decode half additionally accepts the bare-JSON form this
 * function historically wrote, for the sake of ids in the wild.
 *
 * Each primitive cell link within `data` is rewritten to a full sigil link,
 * with relative links resolved against `base`. That rewriting is what makes
 * the result self-contained: the ids it embeds don't depend on where it was
 * minted, so the URI denotes the same value wherever it later gets read.
 *
 * The standard encoding canonicalizes plain-object key order (UTF-8 byte
 * order, per `3-json-encoding.md` section 10), so two runtimes holding the
 * same value mint the same id regardless of key insertion history -- the
 * property that makes this content addressing actually address content.
 *
 * @param data The value to encode. Must be acyclic.
 * @param base Optional base link; relative links within `data` are resolved
 *   against it.
 * @returns A `data:application/json` URI naming a cell whose content is `data`.
 * @throws If `data` contains a reference cycle.
 */
export function createDataCellURI(
  data: any,
  base?: Cell | NormalizedLink,
): URI {
  const baseLink = isCell(base) ? base.getAsNormalizedFullLink() : base;

  function traverseAndAddBaseIdToRelativeLinks(
    value: any,
    seen: Set<any>,
  ): any {
    if (!isRecord(value)) return value;
    if (seen.has(value)) {
      throw new Error(`Cycle detected when creating data URI`);
    }
    seen.add(value);
    try {
      if (isPrimitiveCellLink(value)) {
        const link = parseLink(value, baseLink);
        return createSigilLinkFromParsedLink(link, {
          includeSchema: true,
          keepAsCell: KeepAsCell.All,
        });
      } else if (isInstance(value)) {
        // A non-link class instance is a leaf: the value encoding represents
        // it via its codec (or rejects it loudly if it has none). Descending
        // into it here would decompose it into its property shape.
        return value;
      } else if (Array.isArray(value)) {
        return value.map((item) =>
          traverseAndAddBaseIdToRelativeLinks(item, seen)
        );
      } else { // isObject
        return Object.fromEntries(
          Object.entries(value).map((
            [key, value],
          ) => [key, traverseAndAddBaseIdToRelativeLinks(value, seen)]),
        );
      }
    } finally {
      seen.delete(value);
    }
  }

  // An `undefined` payload encodes as an empty document, mirroring how a
  // storage document represents an unset value (absent `value` property, not
  // a present-`undefined` one).
  const document = (data === undefined)
    ? {}
    : { value: traverseAndAddBaseIdToRelativeLinks(data, new Set()) };
  const json = jsonFromValue(document);
  // Use encodeURIComponent for UTF-8 safe encoding (matches runtime.ts pattern)
  return `data:application/json,${encodeURIComponent(json)}` as URI;
}

/**
 * Decodes the extracted payload text of an `application/json` `data:` URI.
 * This is the single point of truth for how such payloads read, shared by
 * every reader of them; per-reader payload extraction and error policy stay
 * with the readers (see {@link getJSONFromDataURI} and
 * `storage/transaction/attestation.ts`'s `load()`). Two forms are accepted:
 *
 * - Text bearing the `fvj1:` tag is decoded as the standard `data-model`
 *   `FabricValue` JSON-embedded encoding. Results from this branch are
 *   deep-frozen and may contain `FabricInstance`s.
 * - Any other text is parsed as bare JSON. A `data:` URI _is_ its own
 *   content and such URIs are embedded in persisted documents, so ids with
 *   bare-JSON payloads survive indefinitely; this branch has to stay for as
 *   long as any of them remain, that is, probably forever.
 *
 * @param text The payload text, after any percent- or Base64-decoding.
 * @returns The decoded value.
 * @throws If `text` is neither valid JSON nor a valid encoded `FabricValue`.
 *   Notably, an empty `text` is not valid and is rejected like any other
 *   invalid input.
 */
export function decodeDataURIPayloadText(text: string): FabricValue {
  return seemsLikeJsonEncodedFabricValue(text)
    ? valueFromJson(text, dataUriReconstructionContext)
    : JSON.parse(text);
}

/**
 * Extracts and decodes the payload of a `data:` URI, which is required to
 * have the media type `application/json`. The payload is everything past the
 * first comma, and how it is spelled is dictated by the parameters in the
 * header before that comma:
 *
 * - `;base64` selects Base64. Without it, the payload is percent-encoded.
 * - `;charset=` is honored only as `utf-8` (or `utf8`), and any other value is
 *   rejected. It is UTF-8 either way; the parameter only gets to agree.
 *
 * This reads a strict superset of what gets written by
 * {@link createDataCellURI}, which only ever emits the percent-encoded form
 * with no header parameters (`data:application/json,...`). The Base64 and
 * `charset` spellings are for `data:` URIs originating anywhere else.
 *
 * The extracted payload text is decoded via {@link decodeDataURIPayloadText},
 * which accepts both the standard `fvj1:`-tagged `FabricValue` encoding and
 * bare JSON; see its doc comment for the details of the two forms. (The
 * media type is admittedly a bit of a fib for the tagged form, since the tag
 * prefix makes the payload not actually be JSON.)
 *
 * @param uri The `data:` URI to read.
 * @returns The decoded payload.
 * @throws If `uri` is not an `application/json` `data:` URI, if it declares a
 *   charset other than UTF-8, or if its payload is neither valid JSON nor a
 *   valid encoded `FabricValue` (which includes the empty payload).
 */
export function getJSONFromDataURI(uri: URI | string): any {
  if (!uri.startsWith("data:application/json")) {
    throw new Error(`Invalid URI: ${uri}`);
  }

  // Extract the data part after the comma
  const commaIndex = uri.indexOf(",");
  if (commaIndex === -1) {
    throw new Error(`Invalid data URI format: ${uri}`);
  }

  const header = uri.substring(0, commaIndex);
  const data = uri.substring(commaIndex + 1);

  // Parse the header to check for charset
  const headerParts = header.split(";").map((part) => part.trim());
  for (const part of headerParts) {
    if (part.startsWith("charset=")) {
      const charset = part.substring(8).toLowerCase();
      if (charset !== "utf-8" && charset !== "utf8") {
        throw new Error(
          `Unsupported charset: ${charset}. Only UTF-8 is supported.`,
        );
      }
    }
  }

  // Check if data is base64 encoded
  const isBase64 = headerParts.some((part) => part === "base64");

  let decodedData: string;
  if (isBase64) {
    // Use TextDecoder to properly decode UTF-8 bytes from base64
    const binaryString = atob(data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const decoder = new TextDecoder();
    decodedData = decoder.decode(bytes);
  } else {
    decodedData = decodeURIComponent(data);
  }

  return decodeDataURIPayloadText(decodedData);
}
