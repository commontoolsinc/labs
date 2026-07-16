import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { toCompactDebugString } from "@commonfabric/data-model/value-debug";
import {
  entityRefToString,
  isEntityRef,
} from "@commonfabric/data-model/cell-rep";
import type { URI } from "./sigil-types.ts";

/**
 * Convert an entity ID to URI format with "of:" prefix
 */
export function toURI(value: unknown): URI {
  if (value instanceof FabricHash) {
    // The live id form (an `EntityId`/`createRef` result) is a `FabricHash` in
    // either cell-rep regime.
    return `of:${value}`;
  } else if (isEntityRef(value)) {
    // A serialized entity-ref for the active regime. With the modern cell
    // representation on, that form is the `FabricHash` handled above; the
    // `{ "/": … }` object only arises in legacy mode.
    return `of:${entityRefToString(value)}`;
  } else if (typeof value === "string") {
    // Already has prefix with colon
    if (value.includes(":")) {
      // TODO(seefeld): Remove this once we want to support any URI, ideally
      // once there are no bare ids anymore
      if (!value.startsWith("of:") && !value.startsWith("data:")) {
        throw new Error(`Invalid URI: ${value}`);
      }
      return value as URI;
    } else {
      // Add "of:" prefix
      return `of:${value}`;
    }
  }

  throw new Error(
    `Cannot convert value to URI: ${toCompactDebugString(value)}`,
  );
}

/**
 * Extract the hash from a URI by removing the "of:" prefix
 */
export function fromURI(uri: URI | string): string {
  if (!uri.includes(":")) {
    return uri;
  } else if (uri.startsWith("of:")) {
    return uri.slice(3);
  } else if (uri.startsWith("data:")) {
    return hashOf(uri).toString();
  } else {
    // TODO(seefeld): Remove this once we want to support any URI
    throw new Error(`Invalid URI: ${uri}`);
  }
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
 * An empty payload yields `undefined`, rather than being a parse error.
 *
 * This reads a strict superset of what gets written by `link-utils.ts`'s
 * `createDataCellURI()`, which only ever emits the percent-encoded form with no
 * header parameters (`data:application/json,...`). The Base64 and `charset`
 * spellings are for `data:` URIs originating anywhere else.
 *
 * **Note:** This is the decode half of a matched set: it reads what
 * `createDataCellURI()` writes. The two are a pair by construction -- the
 * encoding chosen there dictates what is decodable here -- but the dependency
 * between the files only runs one way (`link-utils.ts` imports this module,
 * not the reverse), so nothing mechanically holds them in agreement. Change
 * one and the other has to move with it; see the `TODO`s in both bodies.
 *
 * @param uri The `data:` URI to read.
 * @returns The parsed payload, or `undefined` if the payload is empty.
 * @throws If `uri` is not an `application/json` `data:` URI, if it declares a
 *   charset other than UTF-8, or if its payload is not valid JSON.
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

  // TODO(danfuzz): This `JSON.parse()` is the decode half of the `data:` URI
  // boundary, and has to change in lockstep with the `JSON.stringify()` in
  // `link-utils.ts`'s `createDataCellURI()`: whatever encodes the payload
  // determines what can decode it. The `data-model` counterpart is
  // `valueFromJson()`, given a `ReconstructionContext`;
  // `memory/v2.ts`'s `encodeMemoryBoundary()`/`decodeMemoryBoundary()` pair is
  // a worked example of the same boundary, and uses an
  // `EmptyReconstructionContext` because links at that boundary are sigil
  // (plain) data rather than `FabricInstance`s, which is true here too.
  //
  // Note that this decode cannot simply switch over: a `data:` URI _is_ its
  // own content, and such URIs are embedded in persisted documents, so ids in
  // the current (bare JSON) form survive indefinitely. This side will have to
  // accept both forms for as long as any of them remain. The encoded form is
  // self-identifying -- `data-model` tags it `fvj1:` -- and
  // `seemsLikeJsonEncodedFabricValue()` exists to make that distinction.
  return decodedData.length > 0 ? JSON.parse(decodedData) : undefined;
}
