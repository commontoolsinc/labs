# Transaction Semantics & Validation

## Transaction Processing Pipeline

1. **Begin SQLite transaction**.
2. **Verify UCAN auth**: signature, delegation chain, audience; extract
   `client_pubkey`.
3. **Resolve & lock branches** involved in `reads`/`writes`
   (`SELECT ... FOR UPDATE` equivalent).
4. **Read-set check**: current heads **==** asserted `heads`.

   - If mismatch → reject with `{code:"ReadConflict", currentHeads:[…]}`.
5. **Write base check**: `baseHeads` == current heads, unless merge path is
   followed.
6. **Decode & verify changes**:

   - All deps present in base or prior accepted changes in this tx.
   - No duplicate `change_hash`.
   - `actor_id` / seq monotonicity per actor.
7. **Compute digests (merkle-reference)**:

   - `baseHeadsRoot = referJSON({ baseHeads: sorted(baseHeads) })`
   - `changesRoot = referJSON({ changes: sorted(changeIds) })` where
     `changeIds = changes.map(bytes => refer(bytes))`
   - `changeCount`
8. **Verify UCAN nb** matches these digests/count exactly.
9. **Insert provisional tx row**:

   - `prev_tx_ref` from last committed tx in space
   - CBOR TxBody, `tx_body_ref`, `tx_ref` =
     `refer(concat(prev_tx_ref || empty, tx_body_bytes))`
   - Sign `tx_hash` with server key (`server_sig`).
10. **Insert CAS changes**:

    - New blobs → `am_change_blobs`.
    - Index entries → `am_change_index` with `bytes_hash`.
11. **Update heads** in `am_heads` with new heads and `root_hash`.
12. **Run invariants** (materializing docs/paths if needed). Fail closed.
13. **Update TxBody in DB** if provisional changed.
14. **Publish WS notifications** to subscribers.
15. **Commit DB transaction**.

## Idempotency

`clientTxId` stored in `tx_dedup(clientTxId TEXT PRIMARY KEY, tx_id INTEGER)`.
If present, return prior receipt.

## Cryptographic Transaction Chain

Each transaction extends a cryptographic chain:

- **TxBody**: CBOR-encoded transaction data
- **tx_body_hash**: `BLAKE3(CBOR(TxBody))`
- **tx_hash**: `BLAKE3(prev_tx_hash || tx_body_hash)`
- **Server signature**: Ed25519 signature of `tx_hash`
- **Client signature**: Ed25519 signature from UCAN

The chain provides:

- **Tamper detection**: Any modification breaks the hash chain
- **Audit trail**: Complete history of all transactions
- **Verification**: Clients can verify transaction integrity
- **Replication**: Other nodes can verify transaction authenticity
