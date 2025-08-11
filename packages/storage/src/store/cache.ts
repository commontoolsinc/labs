/**
 * Per-branch JSON cache maintenance for query fast-path.
 * Upserts the latest materialized JSON when a write advances a branch.
 */
import type { Database } from "@db/sqlite";
import { getPrepared } from "./prepared.ts";

export function upsertJsonCache(
  db: Database,
  params: { docId: string; branchId: string; seqNo: number; json: string },
): void {
  const { docId, branchId, seqNo, json } = params;
  const { upsertJsonCache } = getPrepared(db);
  upsertJsonCache.run({
    doc_id: docId,
    branch_id: branchId,
    seq_no: seqNo,
    json,
  });
}
