import {
  type EntityKind,
  entityUriSchemePrefix,
  hasEntityUriScheme,
  uriSchemeForEntityKind,
} from "./entity-kind.ts";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import {
  jsonFromValue,
  valueFromJson,
} from "@commonfabric/data-model/codec-json";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { toCompactDebugString } from "@commonfabric/data-model/value-debug";
import {
  entityRefToString,
  isEntityRef,
} from "@commonfabric/data-model/cell-rep";
import type { URI } from "./sigil-types.ts";

export const LEGACY_JSON_DATA_URI_MEDIA_TYPE = "application/json";
export const FABRIC_VALUE_DATA_URI_MEDIA_TYPE =
  "application/vnd.commonfabric.fabric-value";
export const FABRIC_VALUE_DATA_URI_PREFIX =
  `data:${FABRIC_VALUE_DATA_URI_MEDIA_TYPE};charset=utf-8,`;

export class UnsupportedDataURIMediaTypeError extends Error {
  readonly mediaType: string;

  constructor(mediaType: string) {
    super(`Unsupported data URI media type: ${mediaType}`);
    this.name = "UnsupportedDataURIMediaTypeError";
    this.mediaType = mediaType;
  }
}
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

interface ParsedDataURI {
  readonly mediaType: string;
  readonly decodedData: string;
}

/** Parse the transport envelope without interpreting its document payload. */
function parseDataURI(uri: URI | string): ParsedDataURI {
  if (!uri.startsWith("data:")) {
    throw new Error(`Invalid URI: ${uri}`);
  }

  const commaIndex = uri.indexOf(",");
  if (commaIndex === -1) {
    throw new Error(`Invalid data URI format: ${uri}`);
  }

  const header = uri.substring(0, commaIndex);
  const data = uri.substring(commaIndex + 1);

  const headerParts = header.split(";").map((part) => part.trim());
  const mediaType = headerParts[0].slice("data:".length);
  for (const part of headerParts.slice(1)) {
    const lowerPart = part.toLowerCase();
    if (lowerPart.startsWith("charset=")) {
      const charset = lowerPart.substring(8);
      if (charset !== "utf-8" && charset !== "utf8") {
        throw new Error(
          `Unsupported charset: ${charset}. Only UTF-8 is supported.`,
        );
      }
    }
  }

  const isBase64 = headerParts.some((part) => part.toLowerCase() === "base64");

  let decodedData: string;
  if (isBase64) {
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

  return { mediaType, decodedData };
}

/**
 * Decode a supported inline document.
 *
 * The media type is the dispatch authority: legacy JSON remains ordinary JSON,
 * while the Fabric media type requires the versioned `fvj1:` codec payload.
 * Payload shape is never sniffed or reinterpreted across those formats.
 */
export function decodeDataURIValue(uri: URI | string): FabricValue {
  const { mediaType, decodedData } = parseDataURI(uri);
  switch (mediaType) {
    case LEGACY_JSON_DATA_URI_MEDIA_TYPE:
      return decodedData.length > 0
        ? JSON.parse(decodedData) as FabricValue
        : undefined;
    case FABRIC_VALUE_DATA_URI_MEDIA_TYPE:
      return valueFromJson(decodedData);
    default:
      throw new UnsupportedDataURIMediaTypeError(mediaType);
  }
}

/** Encode a Fabric value in the canonical inline-document representation. */
export function encodeFabricValueDataURI(value: FabricValue): URI {
  return `${FABRIC_VALUE_DATA_URI_PREFIX}${
    encodeURIComponent(jsonFromValue(value))
  }` as URI;
}

/** Compatibility name retained while callers migrate to dual-format decode. */
export function getJSONFromDataURI(uri: URI | string): any {
  return decodeDataURIValue(uri);
}
