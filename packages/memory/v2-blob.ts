/**
 * Memory v2 Blob Storage
 *
 * Content-addressed binary blob storage. Blobs are immutable and
 * deduplicated by their content hash.
 *
 * @see spec 02-storage.md §10
 * @module v2-blob
 */

import type { Database } from "@db/sqlite";

export function writeBlob(
  store: Database,
  blob: { hash: string; data: Uint8Array; contentType: string; size: number },
): void {
  store
    .prepare(
      `INSERT OR IGNORE INTO blob_store (hash, data, content_type, size) VALUES (?, ?, ?, ?)`,
    )
    .run(blob.hash, blob.data, blob.contentType, blob.size);
}

export function readBlob(
  store: Database,
  hash: string,
): { data: Uint8Array; contentType: string; size: number } | null {
  const row = store
    .prepare(
      `SELECT data, content_type, size FROM blob_store WHERE hash = ?`,
    )
    .get(hash) as
      | { data: Uint8Array; content_type: string; size: number }
      | undefined;
  if (!row) return null;
  return { data: row.data, contentType: row.content_type, size: row.size };
}
