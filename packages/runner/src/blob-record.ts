/**
 * The record a space's blob store keeps for each blob, and the rules that
 * decide what one may hold. A record is the document `cid:<id>` of the blob's
 * space, where `<id>`, the blob's id, is the hash of the whole record, so a
 * record never changes: the same bytes under another name are another blob.
 * The blob store's routes and `nameBlob()` both write records, and both hold
 * them to these rules.
 */

import type { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import type { URI } from "@commonfabric/memory/interface";

/**
 * A blob as its space's blob store keeps it: its media type, its bytes, and,
 * when it was stored with one, the name of the file they came from.
 */
export type BlobRecord = {
  /** The media type of the bytes. */
  type: string;

  /** The bytes. */
  body: FabricBytes;

  /** The name of the file the bytes came from, if they have one. */
  name?: string;
};

/**
 * Indicates whether `name` may name the file a blob holds, which is so of any
 * non-empty string of well-formed Unicode, one with no unpaired surrogate. A
 * download only ever offers the name as one to save under, encoded so that no
 * character of it can reach a header as itself, so a name is held to no rule
 * of a file system's. The encoding is what needs it well-formed.
 */
export function isBlobFileName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.isWellFormed();
}

/** Returns the id of the document holding the record of the blob `blobId`. */
export function blobDocumentId(blobId: string): URI {
  return `cid:${blobId}`;
}
