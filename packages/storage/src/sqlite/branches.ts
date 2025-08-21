import type { BranchName, BranchState, DocId } from "../../interface.ts";
import type { Database } from "@db/sqlite";
import { getBranchState, getOrCreateBranch, getOrCreateDoc } from "./heads.ts";

/**
 * Create a new branch for a document.
 * If fromBranch is provided, records lineage via parent_branch_id.
 * Idempotent: returns existing branch state if branch already exists.
 */
export async function createBranch(
  db: Database,
  docId: DocId,
  name: BranchName,
  opts?: { fromBranch?: BranchName },
): Promise<BranchState> {
  await getOrCreateDoc(db, docId);

  // If already exists, just return its state (idempotent)
  const existing = safeGetBranchState(db, docId, name);
  if (existing) return existing;

  // Resolve parent if provided
  let parentBranchId: string | undefined;
  if (opts?.fromBranch) {
    const parent = getBranchState(db, docId, opts.fromBranch);
    parentBranchId = parent.branchId;
  }

  const branchId = crypto.randomUUID();
  db.run(
    `INSERT OR IGNORE INTO branches(branch_id, doc_id, name, parent_branch_id)
     VALUES (:branch_id, :doc_id, :name, :parent_branch_id);`,
    { branch_id: branchId, doc_id: docId, name, parent_branch_id: parentBranchId },
  );

  // Ensure default heads row exists for the new branch
  await getOrCreateBranch(db, docId, name);
  return getBranchState(db, docId, name);
}

/**
 * Close a branch. Optionally mark it as merged into another branch.
 * No-op if already closed.
 */
export async function closeBranch(
  db: Database,
  docId: DocId,
  name: BranchName,
  opts?: { mergedInto?: BranchName },
): Promise<void> {
  const state = getBranchState(db, docId, name);
  let mergedIntoBranchId: string | null = null;
  if (opts?.mergedInto) {
    const target = getBranchState(db, docId, opts.mergedInto);
    mergedIntoBranchId = target.branchId;
  }
  db.run(
    `UPDATE branches SET is_closed = 1, merged_into_branch_id = COALESCE(:merged_into, merged_into_branch_id)
     WHERE branch_id = :branch_id;`,
    { merged_into: mergedIntoBranchId, branch_id: state.branchId },
  );
}

function safeGetBranchState(
  db: Database,
  docId: DocId,
  branch: BranchName,
): BranchState | undefined {
  try {
    return getBranchState(db, docId, branch);
  } catch {
    return undefined;
  }
}
