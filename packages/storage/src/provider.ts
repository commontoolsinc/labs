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
} from "../interface.ts";
import { openSqlite, type SqliteHandle } from "./sqlite/db.ts";
import {
  getBranchState as readBranchState,
  getOrCreateBranch as ensureBranch,
  getOrCreateDoc as ensureDoc,
} from "./sqlite/heads.ts";
import { decodeChangeHeader } from "./sqlite/change.ts";
import type { Database } from "@db/sqlite";
import {
  refer as referJson,
  toDigest as refToDigest,
} from "merkle-reference/json";
import { maybeCreateSnapshot } from "./sqlite/snapshots.ts";
import { maybeEmitChunks } from "./sqlite/chunks.ts";
import { isServerMergeEnabled } from "./sqlite/flags.ts";
import { epochForTimestamp, getAutomergeBytesAtSeq } from "./sqlite/pit.ts";
import * as Automerge from "@automerge/automerge";
import { closeBranch } from "./sqlite/branches.ts";

export interface SQLiteSpaceOptions {
  spacesDir: URL; // directory where per-space sqlite files live
}

class SQLiteSpace implements SpaceStorage {
  constructor(private readonly handle: SqliteHandle) {}

  async getOrCreateDoc(docId: DocId): Promise<void> {
    await ensureDoc(this.handle.db, docId);
  }

  async getOrCreateBranch(
    docId: DocId,
    branch: BranchName,
  ): Promise<BranchState> {
    return await ensureBranch(this.handle.db, docId, branch);
  }

  async getBranchState(docId: DocId, branch: BranchName): Promise<BranchState> {
    return readBranchState(this.handle.db, docId, branch);
  }

  async submitTx(req: TxRequest): Promise<TxReceipt> {
    const db = this.handle.db;
    const results: TxDocResult[] = [];

    // Create a stub tx row to satisfy FKs when indexing changes
    const txId = createStubTx(db);

    for (const write of req.writes) {
      const { docId, branch } = write.ref;
      await ensureBranch(db, docId, branch);
      const current = readBranchState(db, docId, branch);

      if (JSON.stringify(current.heads) !== JSON.stringify(write.baseHeads)) {
        // Divergence: optionally synthesize a server merge if enabled
        if (!isServerMergeEnabled(db)) {
          results.push({
            ref: write.ref,
            status: "conflict",
            reason: "baseHeads mismatch",
            newHeads: current.heads,
          });
          continue;
        }
        // Only attempt simple 2-head collapse for now
        if (current.heads.length !== 2) {
          results.push({
            ref: write.ref,
            status: "conflict",
            reason: `cannot server-merge: expected 2 heads, got ${current.heads.length}`,
            newHeads: current.heads,
          });
          continue;
        }
        // Load the current merged doc state (both heads applied)
        const amBytes = getAutomergeBytesAtSeq(db, null, docId, current.branchId, current.seqNo);
        let baseDoc = Automerge.load(amBytes);
        // Synthesize a "merge change" authored by server with parents set to both head hashes.
        // We create a net-zero change by setting and deleting a temporary key in a single change block.
        const TMP_KEY = "__server_merge_marker";
        const mergedDoc = Automerge.change(baseDoc, (d: any) => {
          d[TMP_KEY] = true;
          delete d[TMP_KEY];
        });
        const mergeBytes = Automerge.getLastLocalChange(mergedDoc);
        if (!mergeBytes) {
          results.push({
            ref: write.ref,
            status: "conflict",
            reason: "failed to synthesize merge change",
            newHeads: current.heads,
          });
          continue;
        }
        const header: DecodedChangeHeader = decodeChangeHeader(mergeBytes);
        // Validate parents exactly equal to current heads (no unknown deps)
        const depsSorted = [...header.deps].sort();
        const headsSorted = [...current.heads].sort();
        if (JSON.stringify(depsSorted) !== JSON.stringify(headsSorted)) {
          results.push({
            ref: write.ref,
            status: "conflict",
            reason: "synthesized merge deps do not match current heads",
            newHeads: current.heads,
          });
          continue;
        }
        // Store change blob
        const bytesHash = changeHashToBytes(header.changeHash);
        db.run(
          `INSERT OR IGNORE INTO am_change_blobs(bytes_hash, bytes) VALUES(:bytes_hash, :bytes);`,
          { bytes_hash: bytesHash, bytes: mergeBytes },
        );
        // Index change and update branch state
        let newHeads = current.heads.filter((h) => !header.deps.includes(h));
        let seqNo = current.seqNo + 1;
        db.run(
          `INSERT OR REPLACE INTO am_change_index(doc_id, branch_id, seq_no, change_hash, bytes_hash, deps_json, lamport, actor_id, tx_id, committed_at)
           VALUES(:doc_id, :branch_id, :seq_no, :change_hash, :bytes_hash, :deps_json, :lamport, :actor_id, :tx_id, strftime('%Y-%m-%dT%H:%M:%fZ','now'));`,
          {
            doc_id: docId,
            branch_id: current.branchId,
            seq_no: seqNo,
            change_hash: header.changeHash,
            bytes_hash: bytesHash,
            deps_json: JSON.stringify(header.deps),
            lamport: header.seq,
            actor_id: header.actorId,
            tx_id: txId,
          },
        );
        newHeads.push(header.changeHash);
        newHeads.sort();
        updateHeads(db, current.branchId, newHeads, seqNo, txId);
        const snap = maybeCreateSnapshot(db, docId, current.branchId, seqNo, newHeads, txId);
        if (!snap) {
          // emit chunks from last snapshot upto current seq
          await maybeEmitChunks(db, docId, current.branchId, current.seqNo, seqNo);
        }
        results.push({ ref: write.ref, status: "ok", newHeads, applied: 0 });
        continue;
      }

      let newHeads = current.heads.slice();
      let seqNo = current.seqNo;
      let applied = 0;
      let rejectedReason: string | undefined;

      for (const change of write.changes) {
        const header: DecodedChangeHeader = decodeChangeHeader(change.bytes);
        for (const dep of header.deps) {
          if (!newHeads.includes(dep)) {
            rejectedReason = `missing dep ${dep}`;
            break;
          }
        }
        if (rejectedReason) break;

        // CAS store (dedup) and index
        const bytesHash = changeHashToBytes(header.changeHash);
        db.run(
          `INSERT OR IGNORE INTO am_change_blobs(bytes_hash, bytes) VALUES(:bytes_hash, :bytes);`,
          { bytes_hash: bytesHash, bytes: change.bytes },
        );

        seqNo += 1;
        // actor/seq monotonicity: ensure header.seq > last lamport for this actor on this branch
        const last = db.prepare(
          `SELECT lamport FROM am_change_index WHERE branch_id = :branch_id AND actor_id = :actor_id ORDER BY seq_no DESC LIMIT 1`,
        ).get({ branch_id: current.branchId, actor_id: header.actorId }) as
          | { lamport: number | null }
          | undefined;
        const lastLamport = last?.lamport ?? 0;
        if (lastLamport >= header.seq) {
          rejectedReason =
            `non-monotonic seq for actor ${header.actorId}: ${header.seq} <= ${lastLamport}`;
          break;
        }

        db.run(
          `INSERT OR REPLACE INTO am_change_index(doc_id, branch_id, seq_no, change_hash, bytes_hash, deps_json, lamport, actor_id, tx_id, committed_at)
           VALUES(:doc_id, :branch_id, :seq_no, :change_hash, :bytes_hash, :deps_json, :lamport, :actor_id, :tx_id, strftime('%Y-%m-%dT%H:%M:%fZ','now'));`,
          {
            doc_id: docId,
            branch_id: current.branchId,
            seq_no: seqNo,
            change_hash: header.changeHash,
            bytes_hash: bytesHash,
            deps_json: JSON.stringify(header.deps),
            lamport: header.seq,
            actor_id: header.actorId,
            tx_id: txId,
          },
        );

        // update heads: (heads - deps) ∪ {hash}
        newHeads = newHeads.filter((h) => !header.deps.includes(h));
        newHeads.push(header.changeHash);
        newHeads.sort();
        applied += 1;
      }

      if (rejectedReason) {
        results.push({
          ref: write.ref,
          status: "rejected",
          reason: rejectedReason,
        });
        continue;
      }

      // persist to am_heads
      updateHeads(db, current.branchId, newHeads, seqNo, txId);
      // maybe create a snapshot according to cadence
      const snap = maybeCreateSnapshot(db, docId, current.branchId, seqNo, newHeads, txId);
      if (!snap) {
        await maybeEmitChunks(db, docId, current.branchId, current.seqNo, seqNo);
      }

      // If client-supplied merge collapsed heads to single head and provided mergeOf,
      // mark source branches as closed.
      if ((write.mergeOf?.length ?? 0) > 0 && newHeads.length === 1) {
        for (const src of write.mergeOf!) {
          try {
            await closeBranch(db, docId, src.branch, { mergedInto: branch });
          } catch {
            // ignore close errors (e.g., already closed or missing)
          }
        }
      }

      results.push({ ref: write.ref, status: "ok", newHeads, applied });
    }

    const now = new Date().toISOString();
    return {
      txId,
      committedAt: now,
      results,
      conflicts: results.filter((r) => r.status === "conflict"),
    };
  }

  async getDocBytes(
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
    const { uptoSeqNo } = await import("./sqlite/pit.ts");
    const { project } = await import("./sqlite/projection.ts");

    let targetEpoch: number | undefined = opts?.epoch;
    if (targetEpoch == null && opts?.at) {
      targetEpoch = epochForTimestamp(db, opts.at);
    }
    const targetSeq = targetEpoch == null
      ? state.seqNo
      : uptoSeqNo(db, docId, state.branchId, targetEpoch);

    const amBytes = getAutomergeBytesAtSeq(
      db,
      null,
      docId,
      state.branchId,
      targetSeq,
    );

    const accept = opts?.accept ?? "automerge";
    if (accept === "json") {
      return project(amBytes, opts?.paths);
    }
    return amBytes;
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
    const fromBytes = getAutomergeBytesAtSeq(db, null, docId, from.branchId, from.seqNo);
    const toBytes = getAutomergeBytesAtSeq(db, null, docId, to.branchId, to.seqNo);

    const a = Automerge.load(toBytes);
    const b = Automerge.load(fromBytes);
    const mergedState = Automerge.merge(a, b);

    // Create explicit merge change on target branch with parents = to.heads ∪ from.heads
    const TMP_KEY = "__server_merge_marker";
    const mergedWithMarker = Automerge.change(mergedState, (d: any) => {
      d[TMP_KEY] = true;
      delete d[TMP_KEY];
    });
    const mergeBytes = Automerge.getLastLocalChange(mergedWithMarker);
    if (!mergeBytes) throw new Error("failed to synthesize merge change");
    const header: DecodedChangeHeader = decodeChangeHeader(mergeBytes);

    // Validate deps contain both branches' heads
    const wantDeps = [...to.heads, ...from.heads].sort();
    const gotDeps = [...header.deps].sort();
    if (JSON.stringify(wantDeps) !== JSON.stringify(gotDeps)) {
      throw new Error("synthesized merge deps do not match source+target heads");
    }

    // Persist change blob
    const bytesHash = changeHashToBytes(header.changeHash);
    db.run(
      `INSERT OR IGNORE INTO am_change_blobs(bytes_hash, bytes) VALUES(:bytes_hash, :bytes);`,
      { bytes_hash: bytesHash, bytes: mergeBytes },
    );

    // Index on target branch and update heads
    const seqNo = to.seqNo + 1;
    db.run(
      `INSERT OR REPLACE INTO am_change_index(doc_id, branch_id, seq_no, change_hash, bytes_hash, deps_json, lamport, actor_id, tx_id, committed_at)
       VALUES(:doc_id, :branch_id, :seq_no, :change_hash, :bytes_hash, :deps_json, :lamport, :actor_id, :tx_id, strftime('%Y-%m-%dT%H:%M:%fZ','now'));`,
      {
        doc_id: docId,
        branch_id: to.branchId,
        seq_no: seqNo,
        change_hash: header.changeHash,
        bytes_hash: bytesHash,
        deps_json: JSON.stringify(header.deps),
        lamport: header.seq,
        actor_id: header.actorId,
        tx_id: createStubTx(db),
      },
    );
    let newHeads = to.heads.filter((h) => !header.deps.includes(h));
    newHeads.push(header.changeHash);
    newHeads.sort();
    updateHeads(db, to.branchId, newHeads, seqNo, 0);
    const snap = maybeCreateSnapshot(db, docId, to.branchId, seqNo, newHeads, 0);
    if (!snap) {
      await maybeEmitChunks(db, docId, to.branchId, to.seqNo, seqNo);
    }

    // After successful merge collapse, close source branch if requested
    if (opts?.closeSource ?? true) {
      await closeBranch(db, docId, fromBranch, { mergedInto: toBranch });
    }

    return header.changeHash;
  }
}

function updateHeads(
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

function changeHashToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function hexToBytes(hex: string): Uint8Array {
  return changeHashToBytes(hex);
}

function randomBytes(length: number): Uint8Array {
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return arr;
}

function createStubTx(db: Database): number {
  // Find previous tx hash if any
  const prev = db.prepare(`SELECT tx_hash FROM tx ORDER BY tx_id DESC LIMIT 1`)
    .get() as
      | { tx_hash: Uint8Array }
      | undefined;
  const prevHash = prev?.tx_hash ?? new Uint8Array();
  const txBodyHash = randomBytes(32);
  const txHash = randomBytes(32);
  const stmt = db.prepare(
    `INSERT INTO tx(prev_tx_hash, tx_body_hash, tx_hash, server_sig, server_pubkey, client_sig, client_pubkey, ucan_jwt)
     VALUES(:prev_tx_hash, :tx_body_hash, :tx_hash, :server_sig, :server_pubkey, :client_sig, :client_pubkey, :ucan_jwt)`,
  );
  stmt.run({
    prev_tx_hash: prevHash,
    tx_body_hash: txBodyHash,
    tx_hash: txHash,
    server_sig: randomBytes(64),
    server_pubkey: randomBytes(32),
    client_sig: randomBytes(64),
    client_pubkey: randomBytes(32),
    ucan_jwt: "stub",
  });
  const row = db.prepare(`SELECT tx_id FROM tx ORDER BY tx_id DESC LIMIT 1`)
    .get() as { tx_id: number };
  return row.tx_id;
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
