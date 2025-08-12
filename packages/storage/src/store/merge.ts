/**
 * Server-side merge helpers.
 * - synthesizeAndApplyMergeOnBranch(): collapse multiple heads on a single branch by
 *   synthesizing a no-op change with deps = current heads, then indexing it.
 * - synthesizeAndApplyMergeAcrossBranches(): merge `from` into `to` using Automerge.merge,
 *   synthesize a merge change on the target, index, and update heads.
 */
import type { Database } from "@db/sqlite";
import * as Automerge from "@automerge/automerge";
import { getEnvBoolean } from "../config.ts";
import { getAutomergeBytesAtSeq } from "./pit.ts";
import { createCas } from "./cas.ts";
import { hexToBytes } from "./bytes.ts";
import { updateHeads as updateHeadsShared } from "./heads.ts";
import { decodeChangeHeader } from "./change.ts";

export function synthesizeAndApplyMergeOnBranch(
  db: Database,
  params: {
    docId: string;
    branchId: string;
    currentHeads: ReadonlyArray<string>;
    currentSeqNo: number;
    txId: number;
  },
): { ok: true; changeHash: string; newHeads: string[]; seqNo: number } | {
  ok: false;
} {
  const { docId, branchId, currentHeads, currentSeqNo, txId } = params;
  if (currentHeads.length < 2) return { ok: false };
  const amBytes = getAutomergeBytesAtSeq(db, docId, branchId, currentSeqNo);
  const baseDoc = Automerge.load(amBytes);
  const TMP_KEY = "__server_merge_marker";
  const mergedDoc = Automerge.change(baseDoc, (d: any) => {
    d[TMP_KEY] = true;
    delete d[TMP_KEY];
  });
  const mergeBytes = Automerge.getLastLocalChange(mergedDoc);
  if (!mergeBytes) return { ok: false };
  const hdr = decodeChangeHeader(mergeBytes);
  // Enforce server-merge actor policy for single-branch collapse when enabled
  const enforceActor = getEnvBoolean("ENFORCE_SERVER_MERGE_ACTOR", false);
  if (enforceActor && hdr.actorId !== "server") {
    return { ok: false };
  }
  // Optional: enforce a deterministic server actorId when configured
  // Do not enforce actor policy here; keep single-branch merge permissive
  // Use current heads as the effective deps for head collapse to ensure we remove all prior heads
  const usedDeps = [...currentHeads];
  const cas = createCas(db);
  cas.put("am_change", mergeBytes).catch(() => {});
  const bytesHash = hexToBytes(hdr.changeHash);
  const seqNo = currentSeqNo + 1;
  db.run(
    `INSERT OR REPLACE INTO am_change_index(doc_id, branch_id, seq_no, change_hash, bytes_hash, deps_json, lamport, actor_id, tx_id, committed_at)
     VALUES(:doc_id, :branch_id, :seq_no, :change_hash, :bytes_hash, :deps_json, :lamport, :actor_id, :tx_id, ${"strftime('%Y-%m-%dT%H:%M:%fZ','now')"});`,
    {
      doc_id: docId,
      branch_id: branchId,
      seq_no: seqNo,
      change_hash: hdr.changeHash,
      bytes_hash: bytesHash,
      deps_json: JSON.stringify(usedDeps),
      lamport: hdr.seq,
      actor_id: hdr.actorId,
      tx_id: txId,
    },
  );
  const newHeads = currentHeads.filter((h) => !usedDeps.includes(h));
  newHeads.push(hdr.changeHash);
  newHeads.sort();
  updateHeadsShared(db, branchId, newHeads, seqNo, txId);
  return { ok: true, changeHash: hdr.changeHash, newHeads, seqNo };
}

export function synthesizeAndApplyMergeAcrossBranches(
  db: Database,
  params: {
    docId: string;
    from: { branchId: string; heads: ReadonlyArray<string>; seqNo: number };
    to: { branchId: string; heads: ReadonlyArray<string>; seqNo: number };
    txId: number;
  },
): { changeHash: string; newHeads: string[]; seqNo: number } {
  const { docId, from, to, txId } = params;
  const fromBytes = getAutomergeBytesAtSeq(
    db,
    docId,
    from.branchId,
    from.seqNo,
  );
  const toBytes = getAutomergeBytesAtSeq(db, docId, to.branchId, to.seqNo);
  const a = Automerge.load(toBytes);
  const b = Automerge.load(fromBytes);
  const mergedState = Automerge.merge(a, b);
  const TMP_KEY = "__server_merge_marker";
  const mergedWithMarker = Automerge.change(mergedState, (d: any) => {
    d[TMP_KEY] = true;
    delete d[TMP_KEY];
  });
  const mergeBytes = Automerge.getLastLocalChange(mergedWithMarker);
  if (!mergeBytes) throw new Error("failed to synthesize merge change");
  const header = decodeChangeHeader(mergeBytes);
  // Actor policy not enforced for cross-branch merge in current MVP

  const bytesHash = hexToBytes(header.changeHash);
  db.run(
    `INSERT OR IGNORE INTO am_change_blobs(bytes_hash, bytes) VALUES(:bytes_hash, :bytes);`,
    { bytes_hash: bytesHash, bytes: mergeBytes },
  );
  const seqNo = to.seqNo + 1;
  db.run(
    `INSERT OR REPLACE INTO am_change_index(doc_id, branch_id, seq_no, change_hash, bytes_hash, deps_json, lamport, actor_id, tx_id, committed_at)
     VALUES(:doc_id, :branch_id, :seq_no, :change_hash, :bytes_hash, :deps_json, :lamport, :actor_id, :tx_id, ${"strftime('%Y-%m-%dT%H:%M:%fZ','now')"});`,
    {
      doc_id: docId,
      branch_id: to.branchId,
      seq_no: seqNo,
      change_hash: header.changeHash,
      bytes_hash: bytesHash,
      deps_json: JSON.stringify(header.deps),
      lamport: header.seq,
      actor_id: header.actorId,
      tx_id: txId,
    },
  );
  const newHeads = to.heads.filter((h) => !header.deps.includes(h));
  newHeads.push(header.changeHash);
  newHeads.sort();
  updateHeadsShared(db, to.branchId, newHeads, seqNo, txId);
  return { changeHash: header.changeHash, newHeads, seqNo };
}
