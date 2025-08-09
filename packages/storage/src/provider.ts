import type {
  BranchName,
  BranchState,
  DocId,
  SpaceStorage,
  StorageProvider,
  TxReceipt,
  TxRequest,
  DecodedChangeHeader,
  TxDocResult,
} from "../interface.ts";
import { openSqlite, type SqliteHandle } from "./sqlite/db.ts";
import { getBranchState as readBranchState, getOrCreateBranch as ensureBranch, getOrCreateDoc as ensureDoc } from "./sqlite/heads.ts";
import { decodeChangeHeader } from "./sqlite/change.ts";
import type { Database } from "@db/sqlite";

export interface SQLiteSpaceOptions {
  spacesDir: URL; // directory where per-space sqlite files live
}

class SQLiteSpace implements SpaceStorage {
  constructor(private readonly handle: SqliteHandle) {}

  async getOrCreateDoc(docId: DocId): Promise<void> {
    await ensureDoc(this.handle.db, docId);
  }

  async getOrCreateBranch(docId: DocId, branch: BranchName): Promise<BranchState> {
    return await ensureBranch(this.handle.db, docId, branch);
  }

  async getBranchState(docId: DocId, branch: BranchName): Promise<BranchState> {
    return readBranchState(this.handle.db, docId, branch);
  }

  async submitTx(req: TxRequest): Promise<TxReceipt> {
    const db = this.handle.db;
    const results: TxDocResult[] = [];

    for (const write of req.writes) {
      const { docId, branch } = write.ref;
      await ensureBranch(db, docId, branch);
      const current = readBranchState(db, docId, branch);

      if (JSON.stringify(current.heads) !== JSON.stringify(write.baseHeads)) {
        results.push({ ref: write.ref, status: "conflict", reason: "baseHeads mismatch", newHeads: current.heads });
        continue;
      }

      let newHeads = current.heads.slice();
      let seqNo = current.seqNo;
      let applied = 0;
      let rejectedReason: string | undefined;

      for (const change of write.changes) {
        const header: DecodedChangeHeader = decodeChangeHeader(change.bytes);
        // verify deps subset of current heads
        for (const dep of header.deps) {
          if (!newHeads.includes(dep)) {
            rejectedReason = `missing dep ${dep}`;
            break;
          }
        }
        if (rejectedReason) break;

        // update heads: (heads - deps) ∪ {hash}
        newHeads = newHeads.filter((h) => !header.deps.includes(h));
        newHeads.push(header.changeHash);
        newHeads.sort();
        seqNo += 1;
        applied += 1;
      }

      if (rejectedReason) {
        // do not persist, report rejection
        results.push({ ref: write.ref, status: "rejected", reason: rejectedReason });
        continue;
      }

      // persist to am_heads
      updateHeads(db, current.branchId, newHeads, seqNo, current.epoch + 1);
      results.push({ ref: write.ref, status: "ok", newHeads, applied });
    }

    const now = new Date().toISOString();
    return {
      txId: 0,
      committedAt: now,
      results,
      conflicts: results.filter((r) => r.status === "conflict"),
    };
  }

  getDocBytes(): Promise<Uint8Array> {
    throw new Error("not implemented: getDocBytes");
  }
}

function updateHeads(db: Database, branchId: string, heads: string[], seqNo: number, epoch: number): void {
  const headsJson = JSON.stringify(heads);
  db.run(
    `UPDATE am_heads SET heads_json = :heads_json, seq_no = :seq_no, tx_id = :tx_id, root_hash = x'', committed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE branch_id = :branch_id`,
    { heads_json: headsJson, seq_no: seqNo, tx_id: epoch, branch_id: branchId },
  );
}

export function createStorageProvider(): StorageProvider {
  return {
    info: { name: "@commontools/storage", version: "0.0.0" },
  };
}

export async function openSpaceStorage(
  spaceDid: string,
  opts: SQLiteSpaceOptions,
): Promise<SpaceStorage> {
  const file = new URL(`./${spaceDid}.sqlite`, opts.spacesDir);
  await Deno.mkdir(opts.spacesDir, { recursive: true });
  const handle = await openSqlite({ url: file });
  return new SQLiteSpace(handle);
}
