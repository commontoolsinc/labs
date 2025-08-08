# Storage & Replay

## Why CAS + index + caches?

- **CAS change blobs** are the **only** copy of raw change bytes (dedup, audit).
- **Index** gives per-branch order and tx mapping (range scans).
- **Snapshots** + **chunks** accelerate reads without duplicating semantics.

## Point-in-time (epoch/timestamp)

1. Time → epoch:

   ```sql
   SELECT tx_id FROM tx WHERE committed_at <= ? ORDER BY tx_id DESC LIMIT 1;
   ```

2. Epoch → seq:

   ```sql
   SELECT MAX(seq_no) FROM am_change_index WHERE doc_id=? AND branch_id=? AND tx_id<=?;
   ```

3. **Fast path**: snapshot ≤ seq + concat chunks `(snapshot_seq, seq]`.
4. **Fallback**: snapshot (or init) + apply change bytes from
   `am_change_index JOIN am_change_blobs`.

## Catch-up streaming

```sql
SELECT i.doc_id, i.branch_id, i.seq_no, b.bytes, i.tx_id
FROM am_change_index i
JOIN am_change_blobs b USING (bytes_hash)
WHERE i.tx_id > ?
ORDER BY i.tx_id, i.doc_id, i.branch_id, i.seq_no;
```

## Auditing a tx

- Read `tx_body`, recompute `tx_body_hash`, `tx_hash` with the stored
  `prev_tx_hash`.
- Verify `server_sig` over `tx_hash`.
- Verify UCAN signature & delegation.
- Recompute `changesRoot` from `am_change_*` rows in that tx; compare to
  body/UCAN.
- Recompute `root_hash` from `am_heads` and match `TxBody.newHeads`.

## Snapshots & chunks policy

- Snapshot every **N changes** (e.g., 500) or **M MiB** delta (2–4 MiB).
- Chunks generated per change (or batched) via `saveIncremental()`.
- Background worker can (re)build both from `am_change_*`.
