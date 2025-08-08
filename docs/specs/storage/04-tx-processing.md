# Transaction Processing

**Atomic unit**: one POST `/v1/:space/tx` can touch multiple docs/branches;
commit or reject atomically.

## Client request

- `reads[]` with exact **heads** they observed.
- `writes[]` with **baseHeads** and **ordered change bytes** (base64).
- `ucan` invocation that binds to **digests** (see `07-ucan.md`).

## Server pipeline

1. **Begin DB tx** (IMMEDIATE).
2. **Auth**: verify UCAN chain/audience/exp; extract `client_pubkey`.
3. **Resolve branches**; 404 if missing (except doc creation path).
4. **Lock/version read**: load current heads for all touched branches.
5. **Read-set check**: `currentHeads == reads.heads` (set equality). If mismatch
   → `409 ReadConflict`.
6. **Write base check**: for each write, `currentHeads == baseHeads`. (Merges
   are client-provided change(s); server doesn't auto-merge.)
7. **Decode & prelim change checks**: decode change headers; validate no dup
   `change_hash`, deps plausibility.
8. **Compute digests** from request bytes:
   - `baseHeadsRoot = blake3(sorted(baseHeads))`
   - `changesRoot = blake3(concat(blake3(change_bytes_i)))`
   - `changeCount`
9. **Verify UCAN binding**: UCAN `nb` must match the digests above.
10. **Insert tx row (provisional)**:
    - `prev_tx_hash` = last `tx_hash` or zeros if genesis
    - Build **TxBody** (includes `newHeads` later set)
    - `tx_body_hash = blake3(CBOR(TxBody_partial))`
    - `tx_hash = blake3(prev || tx_body_hash)`
    - `server_sig = Ed25519.sign(server_sk, tx_hash)`
    - Insert `tx`, `tx_body` (CBOR)
11. **Insert changes** (CAS):
    - For each change: compute `bytes_hash = blake3(bytes)`
    - `INSERT OR IGNORE am_change_blobs(bytes_hash, bytes)`
    - Insert `am_change_index` row(s) with new **seq_no** values
12. **Recompute changesRoot from DB** for the txn span (ordered bytes) and
    assert it equals the request's digest; assert `changeCount`.
13. **Materialize new heads**:
    - Load doc fast (snapshot+chunks or apply changes) and compute heads.
    - Compute `root_hash = blake3(CBOR({heads:sorted}))`.
    - Update `am_heads` for each branch; fill `TxBody.newHeads`; update
      `tx_docs`.
14. **Finalize tx**: update `tx_body` (full), `tx.tx_body_hash`, `tx.tx_hash`,
    re-sign if needed (or compute hashes after final body; either is fine if
    `newHeads` are deterministic).
15. **Publish WS** per impacted (doc,branch) with `epoch=tx_id`, `txHash`,
    `serverSig`, `changes[]`, `newHeads[]`.
16. **Commit** the SQLite transaction.

**Idempotency**: support `clientTxId` via a small dedup map; return prior
receipt.
