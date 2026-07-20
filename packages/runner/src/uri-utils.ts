import {
  type EntityKind,
  entityUriSchemePrefix,
  hasEntityUriScheme,
  uriSchemeForEntityKind,
} from "./entity-kind.ts";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { toCompactDebugString } from "@commonfabric/data-model/value-debug";
import {
  entityRefToString,
  isEntityRef,
} from "@commonfabric/data-model/cell-rep";
import {
  seemsLikeJsonEncodedFabricValue,
  valueFromJson,
} from "@commonfabric/data-model/codec-json";
import { EmptyReconstructionContext } from "@commonfabric/data-model/codec-common";
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
 * Convert an entity ID to URI format. The scheme carries the entity kind:
 * no kind ⇒ `of:`, `kind: "computed"` ⇒ `computed:` (see `entity-kind.ts`).
 *
 * The resulting URI STRING is the identity — never rebuild a computed
 * cell's URI from its bare hash (`fromURI` strips the scheme, so a
 * round-trip through the bare form would silently rename the entity to its
 * `of:` sibling). `kind` is a minting-time argument: passing it alongside
 * an already-schemed string throws rather than re-scheming an existing
 * identity.
 */
export function toURI(value: unknown, kind?: EntityKind): URI {
  if (value instanceof FabricHash) {
    // The live id form (an `EntityId`/`createRef` result) is a `FabricHash` in
    // either cell-rep regime.
    return `${uriSchemeForEntityKind(kind)}:${value}`;
  } else if (isEntityRef(value)) {
    // A serialized entity-ref for the active regime. With the modern cell
    // representation on, that form is the `FabricHash` handled above; the
    // `{ "/": … }` object only arises in legacy mode.
    return `${uriSchemeForEntityKind(kind)}:${entityRefToString(value)}`;
  } else if (typeof value === "string") {
    // Already has prefix with colon
    if (value.includes(":")) {
      if (kind !== undefined) {
        throw new Error(
          `Cannot mint kind "${kind}" onto an already-schemed URI: ${value}`,
        );
      }
      // TODO(seefeld): Remove this once we want to support any URI, ideally
      // once there are no bare ids anymore
      if (!hasEntityUriScheme(value) && !value.startsWith("data:")) {
        throw new Error(`Invalid URI: ${value}`);
      }
      return value as URI;
    } else {
      // Add the scheme prefix
      return `${uriSchemeForEntityKind(kind)}:${value}`;
    }
  }

  throw new Error(
    `Cannot convert value to URI: ${toCompactDebugString(value)}`,
  );
}

/**
 * Extract the hash from a URI by removing the entity scheme (`of:` or
 * `computed:`). NOTE: the scheme is part of the identity — the bare hash of
 * a `computed:` id is NOT an alias for it, so never feed the result back
 * into `toURI` expecting the same entity.
 */
export function fromURI(uri: URI | string): string {
  const entityScheme = entityUriSchemePrefix(uri);
  if (!uri.includes(":")) {
    return uri;
  } else if (entityScheme !== undefined) {
    return uri.slice(entityScheme.length);
  } else if (uri.startsWith("data:")) {
    return hashOf(uri).toString();
  } else {
    // TODO(seefeld): Remove this once we want to support any URI
    throw new Error(`Invalid URI: ${uri}`);
  }
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
 * The extracted payload text is decoded in one of two ways:
 *
 * - A payload bearing the `fvj1:` tag is decoded as the standard `data-model`
 *   `FabricValue` JSON-embedded encoding. Results from this branch are
 *   deep-frozen and may contain `FabricInstance`s. (The media type is
 *   admittedly a bit of a fib for this form, since the tag prefix makes the
 *   payload not actually be JSON.)
 * - Any other payload is parsed as bare JSON. A `data:` URI _is_ its own
 *   content and such URIs are embedded in persisted documents, so ids with
 *   bare-JSON payloads survive indefinitely; this branch has to stay for as
 *   long as any of them remain, that is, probably forever.
 *
 * An empty payload yields `undefined`, rather than being a decode error.
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
 * one and the other has to move with it; see the `TODO` in that function's
 * body.
 *
 * @param uri The `data:` URI to read.
 * @returns The decoded payload, or `undefined` if the payload is empty.
 * @throws If `uri` is not an `application/json` `data:` URI, if it declares a
 *   charset other than UTF-8, or if its payload is neither valid JSON nor a
 *   valid encoded `FabricValue`.
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

  if (decodedData.length === 0) {
    return undefined;
  }

  return seemsLikeJsonEncodedFabricValue(decodedData)
    ? valueFromJson(decodedData, dataUriReconstructionContext)
    : JSON.parse(decodedData);
}
