/**
 * The schema-document registry: the strong, realm-lifetime index from a
 * schema document's tagged hash to its interned schema, backing `cid:`
 * `$ref` resolution (`docs/specs/content-addressed-schemas.md`).
 *
 * The registry is module-level rather than per-runtime because resolution
 * happens in pure schema code with no runtime handle, and because content
 * addressing makes realm-wide sharing safe: registration verifies every
 * document's content against its claimed hash, so an entry can only ever be
 * the one value its key names, whoever registered it. Memory is bounded by
 * the number of distinct schema documents the realm has seen — strictly
 * less than the duplicated inline copies they replace.
 *
 * Entries are strong on purpose: a `cid:` ref in a link or selector must
 * resolve for as long as the realm lives, and the schema intern table's
 * `WeakRef`s cannot promise that.
 */

import type { JSONSchema } from "@commonfabric/api";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { collectExternalSchemaRefHashes } from "./schema-decompose.ts";

/** Thrown when a document's content does not hash to its claimed id. */
export class SchemaDocumentHashMismatchError extends Error {
  constructor(readonly claimed: string, readonly actual: string) {
    super(
      `Schema document content does not match its id: claimed \`${claimed}\`, hashed \`${actual}\``,
    );
    this.name = "SchemaDocumentHashMismatchError";
  }
}

const documentsByHash = new Map<string, JSONSchema>();

/**
 * Registers a schema document under its tagged hash, verifying the content
 * against the claim first — a mismatched document throws
 * {@link SchemaDocumentHashMismatchError} and never enters the registry.
 * Returns the interned schema. Re-registering a hash is idempotent by
 * construction: only one content can verify against it.
 *
 * The schema is interned, and interning deep-freezes a mutable input in
 * place — callers must be okay with that.
 */
export function registerSchemaDocument(
  taggedHash: string,
  schema: JSONSchema,
): JSONSchema {
  // Verify before the existing-entry check, so a mismatched registration is
  // surfaced even when a correct document already holds the key. Interning
  // memoizes by identity, so re-registering the same object stays cheap.
  const sah = internSchema(schema, true);
  if (sah.taggedHashString !== taggedHash) {
    throw new SchemaDocumentHashMismatchError(
      taggedHash,
      sah.taggedHashString,
    );
  }
  const existing = documentsByHash.get(taggedHash);
  if (existing !== undefined) return existing;
  const interned = sah.schemaOrUndefined as JSONSchema;
  documentsByHash.set(taggedHash, interned);
  return interned;
}

/**
 * The registered schema document for `taggedHash`, or `undefined` when none
 * has been registered. A miss is recoverable — the document may arrive by
 * sync later — which is why resolution failures over external refs are
 * never memoized (see `cfc/schema-refs.ts`).
 */
export function lookupSchemaDocument(
  taggedHash: string,
): JSONSchema | undefined {
  return documentsByHash.get(taggedHash);
}

// Hashes whose transitive closure is fully registered. Registration is
// monotonic and documents are immutable, so completeness is stable once
// true — memoizing `true` is safe, and an incomplete verdict is recomputed
// on the next ask.
const completeClosures = new Set<string>();

/**
 * Whether `taggedHash`'s document and every document transitively reachable
 * from its external refs are registered. Resolution treats an incomplete
 * closure as a miss (`cfc/schema-refs.ts`), so a derived result — an IFC
 * scan, a standardized form — is only ever computed over a schema whose
 * whole closure is at hand; a result cached before a child document arrived
 * would otherwise stay wrong forever.
 */
/**
 * Whether every external ref `schema` carries has a fully registered
 * closure. Trivially true for a schema with no external refs. Derived
 * caches keyed by schema identity (`schemaHasIfc`'s memo, `schemaAtPath`'s)
 * consult this before memoizing: a verdict computed while part of the
 * closure was absent must not outlive the closure's arrival.
 */
export function isExternalClosureComplete(
  schema: JSONSchema | undefined,
): boolean {
  for (const hash of collectExternalSchemaRefHashes(schema)) {
    if (!isSchemaDocumentClosureComplete(hash)) return false;
  }
  return true;
}

export function isSchemaDocumentClosureComplete(taggedHash: string): boolean {
  if (completeClosures.has(taggedHash)) return true;
  const visited = new Set<string>();
  const pending = [taggedHash];
  while (pending.length > 0) {
    const hash = pending.pop()!;
    if (visited.has(hash) || completeClosures.has(hash)) continue;
    visited.add(hash);
    const document = documentsByHash.get(hash);
    if (document === undefined) return false;
    pending.push(...collectExternalSchemaRefHashes(document));
  }
  for (const hash of visited) completeClosures.add(hash);
  return true;
}
