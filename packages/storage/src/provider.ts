import type {
  BranchName,
  BranchState,
  DecodedChangeHeader,
  DocId,
  SpaceStorage,
  StorageProvider,
  TxDocResult,
  TxReceipt,
  TxRequest,
} from "./interface.ts";
import { openSqlite, type SqliteHandle } from "./store/db.ts";
import {
  getBranchState as readBranchState,
  getOrCreateBranch as ensureBranch,
  getOrCreateDoc as ensureDoc,
} from "./store/heads.ts";
import { decodeChangeHeader } from "./store/change.ts";
import type { Database } from "@db/sqlite";
import { maybeCreateSnapshot } from "./store/snapshots.ts";
import { maybeEmitChunks } from "./store/chunks.ts";
import { isServerMergeEnabled } from "./store/flags.ts";
import {
  epochForTimestamp,
  getAutomergeBytesAtSeq,
  uptoSeqNo,
} from "./store/pit.ts";
import { synthesizeAndApplyMergeAcrossBranches } from "./store/merge.ts";
import * as Automerge from "@automerge/automerge";
import { closeBranch } from "./store/branches.ts";
import { updateHeads as updateHeadsShared } from "./store/heads.ts";
import { createStubTx } from "./store/tx_chain.ts";
import { submitTx as submitTxInternal } from "./store/tx.ts";
import type {
  TxReceipt as SqliteTxReceipt,
  TxRequest as SqliteTxRequest,
} from "./store/tx.ts";
import { project } from "./store/projection.ts";

export interface SQLiteSpaceOptions {
  spacesDir: URL; // directory where per-space sqlite files live
}

class SQLiteSpace implements SpaceStorage {
  constructor(private readonly handle: SqliteHandle) {}

  // Ensure single-writer semantics on a per-space DB handle by serializing
  // submitTx calls. SQLite does not support nested transactions, and our
  // tx pipeline uses BEGIN IMMEDIATE; concurrent calls on the same handle
  // would otherwise throw "cannot start a transaction within a transaction".
  private writeQueue: Promise<unknown> = Promise.resolve();

  async getOrCreateDoc(docId: DocId): Promise<void> {
    await ensureDoc(this.handle.db, docId);
  }

  async getOrCreateBranch(
    docId: DocId,
    branch: BranchName,
  ): Promise<BranchState> {
    return await ensureBranch(this.handle.db, docId, branch);
  }

  getBranchState(docId: DocId, branch: BranchName): Promise<BranchState> {
    return Promise.resolve(readBranchState(this.handle.db, docId, branch));
  }

  async submitTx(req: TxRequest): Promise<TxReceipt> {
    // Serialize all writes on this DB handle
    const run = async (): Promise<TxReceipt> => {
      const db = this.handle.db;

      // Translate public TxRequest → internal sqlite/tx TxRequest
      const reads: SqliteTxRequest["reads"] = (req.reads ?? []).map((r) => ({
        docId: r.ref.docId,
        branch: r.ref.branch,
        heads: r.heads,
      }));
      const writes: SqliteTxRequest["writes"] = req.writes.map((w) => ({
        docId: w.ref.docId,
        branch: w.ref.branch,
        baseHeads: w.baseHeads,
        changes: w.changes.map((c) => ({ bytes: c.bytes })),
        allowServerMerge: w.allowServerMerge ?? isServerMergeEnabled(db),
      }));

      const receipt: SqliteTxReceipt = await submitTxInternal(db, {
        reads,
        writes,
      });

      // Map internal receipt → public receipt shape
      const results: TxDocResult[] = receipt.results.map((r: any) => ({
        ref: { docId: r.docId, branch: r.branch },
        status: r.status,
        newHeads: r.newHeads,
        applied: r.applied,
        reason: r.reason,
      }));

      return {
        txId: receipt.txId,
        committedAt: new Date().toISOString(),
        results,
        conflicts: results.filter((r) => r.status === "conflict"),
      };
    };

    const p = this.writeQueue.then(run, run) as Promise<TxReceipt>;
    // Ensure subsequent calls wait for this one regardless of success/failure
    this.writeQueue = p.then(() => undefined, () => undefined);
    return await p;
  }

  getDocBytes(
    docId: DocId,
    branch: BranchName,
    opts?: {
      accept?: "automerge" | "json";
      epoch?: number;
      at?: string;
      paths?: string[][];
    },
  ): Promise<Uint8Array> {
    const db = this.handle.db;
    const state = readBranchState(db, docId, branch);

    let targetEpoch: number | undefined = opts?.epoch;
    if (targetEpoch == null && opts?.at) {
      targetEpoch = epochForTimestamp(db, opts.at);
    }
    const targetSeq = targetEpoch == null
      ? state.seqNo
      : uptoSeqNo(db, docId, state.branchId, targetEpoch);

    const amBytes = getAutomergeBytesAtSeq(
      db,
      docId,
      state.branchId,
      targetSeq,
    );

    const accept = opts?.accept ?? "automerge";
    if (accept === "json") {
      return Promise.resolve(project(amBytes, opts?.paths));
    }
    return Promise.resolve(amBytes);
  }

  async mergeBranches(
    docId: DocId,
    fromBranch: BranchName,
    toBranch: BranchName,
    opts?: { closeSource?: boolean },
  ): Promise<string> {
    const db = this.handle.db;
    if (!isServerMergeEnabled(db)) {
      throw new Error("server merge disabled");
    }
    const from = readBranchState(db, docId, fromBranch);
    const to = readBranchState(db, docId, toBranch);

    // Load PIT docs for both branches at their current seq
    const { changeHash, newHeads, seqNo } =
      synthesizeAndApplyMergeAcrossBranches(
        db,
        {
          docId,
          from,
          to,
          txId: createStubTx(db),
        },
      );
    const snap = maybeCreateSnapshot(
      db,
      docId,
      to.branchId,
      seqNo,
      newHeads,
      0,
    );
    if (!snap) {
      await maybeEmitChunks(db, docId, to.branchId, to.seqNo, seqNo);
    }

    // After successful merge collapse, close source branch if requested
    if (opts?.closeSource ?? true) {
      closeBranch(db, docId, fromBranch, { mergedInto: toBranch });
    }

    return changeHash;
  }

  // Non-interface helper for tests and graceful shutdown
  async close(): Promise<void> {
    await this.handle.close();
  }
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

// JSON projection helpers moved to ./sqlite/projection.ts
