/**
 * The `data:` URI codec. The runner uses `application/json` `data:` URIs as
 * self-contained content-addressed cell ids: the URI _is_ its content, so
 * reading such a cell means decoding its own id. This module holds the whole
 * matched set -- the minting side ({@link createDataCellURI}) and the reading
 * side ({@link getJSONFromDataURI} and {@link decodeDataURIPayloadText}) --
 * because the encoding chosen by the one dictates what is decodable by the
 * other, and colocating them is what keeps a change to either from drifting
 * away from its partner. {@link findAndInlineDataURILinks}, which dissolves
 * `data:` URI links back into the values they carry, lives here for the same
 * reason: it is a direct consumer of the decode half.
 *
 * The dependency on the link machinery is one-way: this module imports from
 * `link-utils.ts`, and `link-utils.ts` imports nothing back. The
 * relationship with `cell.ts` is mutual -- this module needs `isCell` (and
 * the `Cell` type) while `cell.ts` consumes the codec -- the same two-way
 * shape `cell.ts` and `link-utils.ts` had while the codec lived there,
 * relocated rather than newly introduced.
 */

import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { isRecord } from "@commonfabric/utils/types";
import { type Cell, isCell } from "./cell.ts";
import { isPrimitiveCellLink, type NormalizedLink } from "./link-types.ts";
import {
  createSigilLinkFromParsedLink,
  isCellLink,
  KeepAsCell,
  parseLink,
} from "./link-utils.ts";
import { ContextualFlowControl } from "./cfc.ts";
import type { URI } from "./sigil-types.ts";

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
 * {@link getJSONFromDataURI} is what reads back what this writes.
 *
 * Each primitive cell link within `data` is rewritten to a full sigil link,
 * with relative links resolved against `base`. That rewriting is what makes
 * the result self-contained: the ids it embeds don't depend on where it was
 * minted, so the URI denotes the same value wherever it later gets read.
 *
 * **Note:** This does not use the standard `data-model` value encoding, and
 * callers are exposed to two consequences. A `FabricSpecialObject` within
 * `data` is not represented correctly, and plain-object keys are not
 * canonicalized -- so two runtimes holding the same value can mint two
 * different ids for it, which is to say that the content addressing here is
 * not reliably addressing content. See the `TODO`s in the body.
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

  // TODO(danfuzz): This `isRecord`-gated walk guards only `isPrimitiveCellLink`;
  // a `FabricPrimitive`/`FabricInstance` that is not a link falls through to the
  // `Object.entries` descent (primitive decomposed, instance walked by internal
  // slots).
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
  // TODO(danfuzz): This `JSON.stringify()` should be changed to use the
  // standard `data-model` value encoding, both so that `FabricSpecialObject`s
  // can be properly represented and so that plain objects get properly
  // canonicalized. Once this is done, the changes to `schema-hash.ts` made in
  // PR #4360 should be able to be reverted, as those changes amount to a
  // workaround for the plain object canonicalization issue.
  const json = JSON.stringify({
    value: traverseAndAddBaseIdToRelativeLinks(data, new Set()),
  });
  // Use encodeURIComponent for UTF-8 safe encoding (matches runtime.ts pattern)
  return `data:application/json,${encodeURIComponent(json)}` as URI;
}

/**
 * Decodes the extracted payload text of an `application/json` `data:` URI.
 * This is the single point of truth for how such payloads read, shared by
 * every reader of them; per-reader payload extraction and error policy stay
 * with the readers (see {@link getJSONFromDataURI} and
 * `storage/transaction/attestation.ts`'s `load()`).
 *
 * @param text The payload text, after any percent- or Base64-decoding.
 * @returns The decoded value.
 * @throws If `text` is not valid JSON. Notably, an empty `text` is not valid
 *   JSON and is rejected like any other invalid input.
 */
export function decodeDataURIPayloadText(text: string): FabricValue {
  // TODO(danfuzz): This `JSON.parse()` is the decode half of the `data:` URI
  // boundary, and has to change in lockstep with the `JSON.stringify()` in
  // `createDataCellURI()` above: whatever encodes the payload determines what
  // can decode it. The `data-model` counterpart is `valueFromJson()`, given a
  // `ReconstructionContext`; `memory/v2.ts`'s
  // `encodeMemoryBoundary()`/`decodeMemoryBoundary()` pair is a worked example
  // of the same boundary, and uses an `EmptyReconstructionContext` because
  // links at that boundary are sigil (plain) data rather than
  // `FabricInstance`s, which is true here too.
  //
  // Note that this decode cannot simply switch over: a `data:` URI _is_ its
  // own content, and such URIs are embedded in persisted documents, so ids in
  // the current (bare JSON) form survive indefinitely. This side will have to
  // accept both forms for as long as any of them remain. The encoded form is
  // self-identifying -- `data-model` tags it `fvj1:` -- and
  // `seemsLikeJsonEncodedFabricValue()` exists to make that distinction.
  return JSON.parse(text);
}

/**
 * Extracts and parses the JSON payload of a `data:` URI, which is required to
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
 * The extracted payload text is decoded via {@link decodeDataURIPayloadText}.
 *
 * @param uri The `data:` URI to read.
 * @returns The parsed payload.
 * @throws If `uri` is not an `application/json` `data:` URI, if it declares a
 *   charset other than UTF-8, or if its payload is not valid JSON (which
 *   includes the empty payload).
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

/**
 * Find any data: URI links and inline them.
 *
 * TODO(danfuzz): This `isRecord`-gated walk has no `FabricSpecialObject`
 * guard: after the link check, a non-link `FabricPrimitive`/`FabricInstance`
 * falls into the `Object.entries` descent, which walks it by enumerable own
 * props instead of treating it as a leaf. An instance with no enumerable
 * props happens to pass through by reference, but the copy-on-write branch
 * (`{ ...value }`) silently flattens any instance whose entry inlines
 * differently into a plain object. The payload walk
 * (`dataValue[path.shift()]`) indexes into decoded content with the same
 * blindness.
 *
 * @param value - The value to find and inline data: URI links in.
 * @returns The value with any data: URI links inlined.
 */
export function findAndInlineDataURILinks(value: any): any {
  if (isCellLink(value)) {
    const dataLink = parseLink(value)!;

    if (dataLink.id?.startsWith("data:")) {
      let dataValue: any = getJSONFromDataURI(dataLink.id);
      const path = [...dataLink.path];

      // This is a storage item, so we have to look into the "value" field for
      // the actual data.
      if (!isRecord(dataValue)) return undefined;
      dataValue = dataValue["value"];

      // If there is a link on the way to `path`, follow it, appending remaining
      // path to the target link.
      while (dataValue !== undefined) {
        if (isPrimitiveCellLink(dataValue)) {
          // Parse the link found in the data URI
          // Do NOT pass parsedLink as base to avoid inheriting the data: URI id
          const newLink = parseLink(dataValue);
          let schema = newLink.schema;
          if (schema !== undefined && path.length > 0) {
            const cfc = new ContextualFlowControl();
            schema = cfc.getSchemaAtPath(schema, path);
          }
          // Create new link by merging dataLink with remaining path
          const newSigilLink = createSigilLinkFromParsedLink({
            // Start with values from the original data link
            ...dataLink,

            // overwrite with values from the new link
            ...newLink,

            // extend path with remaining segments
            path: [...newLink.path, ...path],

            // use resolved schema if we have one
            ...(schema !== undefined && { schema }),
          }, {
            includeSchema: true,
            keepAsCell: KeepAsCell.All,
          });
          return findAndInlineDataURILinks(newSigilLink);
        }
        if (path.length > 0) {
          dataValue = dataValue[path.shift()!];
        } else {
          break;
        }
      }

      return dataValue;
    } else {
      return value;
    }
  } else if (Array.isArray(value)) {
    let next: any[] | undefined;
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) continue;
      const current = value[index];
      const inlined = findAndInlineDataURILinks(current);
      if (next) {
        next[index] = inlined;
      } else if (!Object.is(inlined, current)) {
        // `Object.is`: an untouched `NaN` leaf comes back as the same value
        // and must not force a clone of the whole array.
        next = value.slice();
        next[index] = inlined;
      }
    }
    return next ?? value;
  } else if (isRecord(value)) {
    let next: Record<string, unknown> | undefined;
    for (const [key, entry] of Object.entries(value)) {
      const inlined = findAndInlineDataURILinks(entry);
      if (next) {
        next[key] = inlined;
      } else if (!Object.is(inlined, entry)) {
        // `Object.is`: see the array case above.
        next = { ...value };
        next[key] = inlined;
      }
    }
    return next ?? value;
  } else {
    return value;
  }
}
