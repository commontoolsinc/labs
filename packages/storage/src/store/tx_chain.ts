import type { Database } from "@db/sqlite";
import { bytesToHex } from "./bytes.ts";

export function randomBytes(length: number): Uint8Array {
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return arr;
}

export function getLastStubCrypto(
  db: Database,
): { prevTxHash: string; txBodyHash: string; txHash: string } {
  const row = db.prepare(
    `SELECT prev_tx_hash, tx_body_hash, tx_hash FROM tx ORDER BY tx_id DESC LIMIT 1`,
  ).get() as
    | {
      prev_tx_hash: Uint8Array;
      tx_body_hash: Uint8Array;
      tx_hash: Uint8Array;
    }
    | undefined;
  if (!row) return { prevTxHash: "", txBodyHash: "", txHash: "" };
  return {
    prevTxHash: bytesToHex(row.prev_tx_hash),
    txBodyHash: bytesToHex(row.tx_body_hash),
    txHash: bytesToHex(row.tx_hash),
  };
}

export function createStubTx(
  db: Database,
  _digests?: {
    baseHeadsRoot?: string;
    changesRoot?: string;
    changeCount: number;
  },
): number {
  const prev = db.prepare(`SELECT tx_hash FROM tx ORDER BY tx_id DESC LIMIT 1`)
    .get() as { tx_hash: Uint8Array } | undefined;
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


