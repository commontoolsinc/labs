import type { Database } from "@db/sqlite";
import * as Automerge from "@automerge/automerge";

export type CasKind = 'am_change' | 'am_snapshot' | 'blob';

export interface CasMeta {
  docId?: string;
  branchId?: string;
  seqNo?: number;
  txId?: number;
  [key: string]: unknown;
}

export interface CasRecord {
  kind: CasKind;
  bytes: Uint8Array;
  meta?: CasMeta | null;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const out = new Uint8Array(digest);
  const hex: string[] = new Array(out.length);
  for (let i = 0; i < out.length; i++) hex[i] = out[i]!.toString(16).padStart(2, "0");
  return hex.join("");
}

export function createCas(db: Database) {
  return {
    async put(kind: CasKind, bytes: Uint8Array, meta?: CasMeta): Promise<string> {
      if (kind === 'am_change') {
        const ch = Automerge.decodeChange(bytes);
        if (!ch.hash) throw new Error('am_change bytes missing change hash');
        const bytesHash = hexToBytes(ch.hash);
        db.run(`INSERT OR IGNORE INTO am_change_blobs(bytes_hash, bytes) VALUES(:bytes_hash, :bytes);`, {
          bytes_hash: bytesHash,
          bytes,
        });
        // Optionally also mirror meta into cas_blobs for unified query, but spec says reuse am_change_blobs if present.
        return ch.hash;
      }
      const digest = await sha256Hex(bytes);
      db.run(
        `INSERT OR IGNORE INTO cas_blobs(digest, kind, bytes, meta_json) VALUES(:digest, :kind, :bytes, :meta_json)`,
        {
          digest,
          kind,
          bytes,
          meta_json: meta ? JSON.stringify(meta) : null,
        },
      );
      return digest;
    },

    get(digest: string): CasRecord | null {
      // First try am_change_blobs
      const change = db.prepare(`SELECT bytes FROM am_change_blobs WHERE bytes_hash = :bytes_hash`).get({
        bytes_hash: hexToBytes(digest),
      }) as { bytes: Uint8Array } | undefined;
      if (change) return { kind: 'am_change', bytes: change.bytes, meta: null };

      const row = db.prepare(`SELECT kind, bytes, meta_json FROM cas_blobs WHERE digest = :digest`).get({ digest }) as
        | { kind: CasKind; bytes: Uint8Array; meta_json: string | null }
        | undefined;
      if (!row) return null;
      return { kind: row.kind, bytes: row.bytes, meta: row.meta_json ? JSON.parse(row.meta_json) : null };
    },

    has(digest: string): boolean {
      const inChange = db.prepare(`SELECT 1 FROM am_change_blobs WHERE bytes_hash = :bytes_hash LIMIT 1`).get({
        bytes_hash: hexToBytes(digest),
      }) as { 1: number } | undefined;
      if (inChange) return true;
      const inCas = db.prepare(`SELECT 1 FROM cas_blobs WHERE digest = :digest LIMIT 1`).get({ digest }) as { 1: number } | undefined;
      return !!inCas;
    },

    // Index helpers
    findChangeBySeq(docId: string, branchId: string, seqNo: number): { digest: string; bytes: Uint8Array } | null {
      const row = db.prepare(
        `SELECT i.change_hash AS digest, b.bytes AS bytes
         FROM am_change_index i
         JOIN am_change_blobs b ON (i.bytes_hash = b.bytes_hash)
         WHERE i.doc_id = :doc_id AND i.branch_id = :branch_id AND i.seq_no = :seq_no`
      ).get({ doc_id: docId, branch_id: branchId, seq_no: seqNo }) as { digest: string; bytes: Uint8Array } | undefined;
      return row ?? null;
    },

    findByTxId(docId: string, branchId: string, txId: number): Array<{ kind: CasKind; digest: string; bytes: Uint8Array }> {
      const rows = db.prepare(
        `SELECT i.change_hash AS digest, b.bytes AS bytes
         FROM am_change_index i
         JOIN am_change_blobs b ON (i.bytes_hash = b.bytes_hash)
         WHERE i.doc_id = :doc_id AND i.branch_id = :branch_id AND i.tx_id = :tx_id
         ORDER BY i.seq_no`
      ).all({ doc_id: docId, branch_id: branchId, tx_id: txId }) as Array<{ digest: string; bytes: Uint8Array }>;
      return rows.map(r => ({ kind: 'am_change' as const, digest: r.digest, bytes: r.bytes }));
    },
  };
}

