import type { BranchName, BranchState, DocId, Heads } from "../../interface.ts";
import type { Database } from "@db/sqlite";

export function getOrCreateDoc(db: Database, docId: DocId): void {
  db.run(`INSERT OR IGNORE INTO docs(doc_id) VALUES (:doc_id);`, { doc_id: docId });
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
     SELECT b.branch_id, '[]', 0, 0, x'', strftime('%Y-%m-%dT%H:%M:%fZ','now')
     FROM branches b WHERE b.doc_id = :doc_id AND b.name = :name;`,
    { doc_id: docId, name: branch },
  );
  return await getBranchState(db, docId, branch);
}

export function getBranchState(
  db: Database,
  docId: DocId,
  branch: BranchName,
): BranchState {
  const stmt = db.prepare(
    `SELECT h.branch_id as branch_id, h.heads_json as heads_json, h.seq_no as seq_no, h.tx_id as tx_id, h.root_hash as root_hash
     FROM am_heads h JOIN branches b ON (h.branch_id = b.branch_id)
     WHERE b.doc_id = :doc_id AND b.name = :name`,
  );
  const row = stmt.get({ doc_id: docId, name: branch }) as
    | { branch_id: string; heads_json: string; seq_no: number; tx_id: number; root_hash: Uint8Array | null }
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

function bytesToHex(bytes: Uint8Array): string {
  const hex: string[] = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!.toString(16).padStart(2, "0");
    hex[i] = byte;
  }
  return hex.join("");
}


