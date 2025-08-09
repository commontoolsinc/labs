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
        results.push({
          ref: write.ref,
          status: "conflict",
          reason: "baseHeads mismatch",
          newHeads: current.heads,
        });
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
      paths?: string[][];
    },
  ): Promise<Uint8Array> {
    const db = this.handle.db;
    const state = readBranchState(db, docId, branch);
    // Load change bytes up to optional epoch
    const rows = db.prepare(
      `SELECT b.bytes AS bytes
       FROM am_change_index i JOIN am_change_blobs b ON (i.bytes_hash = b.bytes_hash)
       WHERE i.doc_id = :doc_id AND i.branch_id = :branch_id AND (:epoch IS NULL OR i.tx_id <= :epoch)
       ORDER BY i.seq_no`,
    ).all({
      doc_id: docId,
      branch_id: state.branchId,
      epoch: opts?.epoch ?? null,
    }) as Array<{ bytes: Uint8Array }>;
    const changes = rows.map((r) => r.bytes);
    // Fallback reconstruction via applyChanges
    // deno-lint-ignore no-explicit-any
    let doc: any = (globalThis as any).AutomergeInit
      ? (globalThis as any).AutomergeInit()
      : undefined;
    // Always use our imported Automerge to avoid global ambiguity
    // dynamic import to avoid circular import at top
    const Automerge = await import("@automerge/automerge");
    const applied = Automerge.applyChanges(Automerge.init(), changes);
    const docRoot = Array.isArray(applied) ? applied[0] : applied;
    const accept = opts?.accept ?? "automerge";
    if (accept === "json") {
      const jsonObj = Automerge.toJS(docRoot);
      const projected = opts?.paths && opts.paths.length > 0
        ? projectJson(jsonObj, opts.paths)
        : jsonObj;
      const bytes = new TextEncoder().encode(JSON.stringify(projected));
      return bytes;
    }
    // default automerge bytes
    const saved = Automerge.save(docRoot);
    return saved;
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

function projectJson(root: unknown, paths: string[][]): unknown {
  // Build a new object containing only the requested paths from root
  const out: any = Array.isArray(root) ? [] : {};
  for (const p of paths) {
    setAtPath(out, p, getAtPath(root as any, p));
  }
  return out;
}

function getAtPath(obj: any, path: string[]): any {
  let cur = obj;
  for (const key of path) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

function setAtPath(obj: any, path: string[], value: any): void {
  let cur = obj;
  for (let i = 0; i < path.length; i++) {
    const key = path[i]!;
    const isLast = i === path.length - 1;
    if (isLast) {
      cur[key] = value;
    } else {
      const next = cur[key];
      if (next == null || typeof next !== "object") {
        cur[key] = {};
      }
      cur = cur[key];
    }
  }
}
