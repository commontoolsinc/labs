import {
  type EntityKind,
  FabricHash,
  uriSchemeForEntityKind,
} from "@commonfabric/data-model/fabric-primitives";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { toCompactDebugString } from "@commonfabric/data-model/value-debug";
import {
  entityRefToString,
  isEntityRef,
} from "@commonfabric/data-model/cell-rep";
import type { URI } from "./sigil-types.ts";

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
      if (
        !value.startsWith("of:") && !value.startsWith("data:") &&
        !value.startsWith("computed:")
      ) {
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
  if (!uri.includes(":")) {
    return uri;
  } else if (uri.startsWith("of:")) {
    return uri.slice("of:".length);
  } else if (uri.startsWith("computed:")) {
    return uri.slice("computed:".length);
  } else if (uri.startsWith("data:")) {
    return hashOf(uri).toString();
  } else {
    // TODO(seefeld): Remove this once we want to support any URI
    throw new Error(`Invalid URI: ${uri}`);
  }
}

/**
 * Extract the JSON object from a data URI
 *
 * Data URIs are a way to embed JSON in a URI. They are a base64 encoded string
 * that is prefixed with "data:application/json". The string is then encoded in
 * base64.
 *
 * The data URI is a string that looks like this:
 *
 * data:application/json;charset=utf-8;base64,
 * @param uri - The data URI to extract the JSON from
 * @returns The JSON object
 * @throws If the URI is invalid or the JSON is invalid
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

  return decodedData.length > 0 ? JSON.parse(decodedData) : undefined;
}
