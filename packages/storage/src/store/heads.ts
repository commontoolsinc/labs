/**
 * Heads state access and initialization for a (doc, branch).
 * - getOrCreateDoc(): ensures a `docs` row exists
 * - getOrCreateBranch(): ensures `branches` + default `am_heads` rows exist
 * - getBranchState(): reads canonical heads, seq, epoch, and rootRef
 * - updateHeads(): persists new heads/seq/epoch and recomputes root_ref
 */
import type { BranchName, BranchState, DocId, Heads } from "../interface.ts";
import {
  refer as referJson,
  toDigest as refToDigest,
} from "merkle-reference/json";
import { bytesToHex } from "./bytes.ts";
import type { Database } from "@db/sqlite";
import { getPrepared } from "./prepared.ts";

export function getOrCreateDoc(db: Database, docId: DocId): void {
  db.run(`INSERT OR IGNORE INTO docs(doc_id) VALUES (:doc_id);`, {
    doc_id: docId,
  });
}

export async function getOrCreateBranch(
  db: Database,
  docId: DocId,
  branch: BranchName,
): Promise<BranchState> {
  await getOrCreateDoc(db, docId);
  // Ensure branch row exists
  const branchId = crypto.randomUUID();
  db.run(
    `INSERT OR IGNORE INTO branches(branch_id, doc_id, name) VALUES (:branch_id, :doc_id, :name);`,
    { branch_id: branchId, doc_id: docId, name: branch },
  );
  // Insert default heads state if missing
  db.run(
    `INSERT OR IGNORE INTO am_heads(branch_id, heads_json, seq_no, tx_id, root_hash, committed_at)
     SELECT b.branch_id, '[]', 0, 0, :root_hash, strftime('%Y-%m-%dT%H:%M:%fZ','now')
     FROM branches b WHERE b.doc_id = :doc_id AND b.name = :name;`,
    {
      doc_id: docId,
      name: branch,
      root_hash: new Uint8Array(refToDigest(referJson({ heads: [] }))),
    },
  );
  return await getBranchState(db, docId, branch);
}

export function getBranchState(
  db: Database,
  docId: DocId,
  branch: BranchName,
): BranchState {
  // Placeholder for future prepared heads selectors
  void getPrepared(db);
  const row = db.prepare(
    `SELECT h.branch_id as branch_id, h.heads_json as heads_json, h.seq_no as seq_no, h.tx_id as tx_id, h.root_hash as root_hash
     FROM am_heads h JOIN branches b ON (h.branch_id = b.branch_id)
     WHERE b.doc_id = :doc_id AND b.name = :name`,
  ).get({ doc_id: docId, name: branch }) as
    | {
      branch_id: string;
      heads_json: string;
      seq_no: number;
      tx_id: number;
      root_hash: Uint8Array | null;
    }
    | undefined;
  if (!row) {
    throw new Error(`Branch not found for doc ${docId} / ${branch}`);
  }
  const heads = JSON.parse(row.heads_json) as Heads;
  return {
    branchId: row.branch_id,
    heads,
    seqNo: row.seq_no,
    epoch: row.tx_id,
    rootRef: row.root_hash ? bytesToHex(row.root_hash) : undefined,
  };
}

export function updateHeads(
  db: Database,
  branchId: string,
  heads: string[],
  seqNo: number,
  epoch: number,
): void {
  const headsJson = JSON.stringify(heads);
  const rootRef = referJson({ heads: [...heads].sort() });
  const rootHashBytes = new Uint8Array(refToDigest(rootRef));
  db.run(
    `UPDATE am_heads SET heads_json = :heads_json, seq_no = :seq_no, tx_id = :tx_id, root_hash = :root_hash, committed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE branch_id = :branch_id`,
    {
      heads_json: headsJson,
      seq_no: seqNo,
      tx_id: epoch,
      branch_id: branchId,
      root_hash: rootHashBytes,
    },
  );
}
