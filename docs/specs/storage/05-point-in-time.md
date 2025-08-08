# Point-in-Time Retrieval

The backend supports **two forms** of point-in-time access to any branch in any space:

1. **By epoch** — use a `tx_id` directly (`epoch=<id>`).
2. **By timestamp** — map a timestamp to the corresponding `tx_id`:

```sql
SELECT tx_id
FROM tx
WHERE committed_at <= ?
ORDER BY tx_id DESC
LIMIT 1
```

## Finding the Sequence Number at an Epoch

To reconstruct a branch at a given epoch, first determine the **last applied change** at or before that epoch:

```sql
SELECT MAX(seq_no) AS upto_seq_no
FROM am_change_index
WHERE doc_id = ?
  AND branch_id = ?
  AND tx_id <= ?
```

## Reconstruction Algorithm

**Preferred fast path (with `am_snapshots` + `am_chunks` caches):**

1. **Find latest snapshot** for `(doc_id, branch_id)` with
   `upto_seq_no <= seq_at_epoch` from step 5.1.
2. **Build stream**:

   * Start with snapshot's `bytes` from `am_snapshots`.
   * Append `bytes` from `am_chunks` where
     `seq_no > snapshot.upto_seq_no AND seq_no <= seq_at_epoch`,
     ordered by `seq_no`.
3. **Concatenate** all bytes → yields an Automerge binary file at that point in time.
4. **Return format**:

   * If `Accept: application/automerge` → return raw binary.
   * Otherwise load via `Automerge.load()` and project to JSON (optionally pruning to requested `paths`).

**Fallback path (no `am_chunks`):**

1. Load latest snapshot ≤ `seq_at_epoch`.
2. Load all `change_hash` values from `am_change_index` in the target range.
3. Fetch `bytes` from `am_change_blobs` for each change.
4. Apply changes via `Automerge.applyChanges()` until reaching target seq.

## Timestamp → Epoch → Branch State

* Given `at=<timestamp>`:

  1. Map timestamp to epoch with query in §5.0.
  2. Follow same reconstruction steps as above.

## Integrity Verification (Optional)

When serving point-in-time retrieval, the server **can** recompute a
`root_ref` using `merkle-reference` over the canonical heads set:

* **root_ref** = `referJSON({ heads: sorted(heads) })` at that epoch.
* Compare to stored `root_ref` in `am_heads` (if retrieving the current state)
  or to a recomputed value from reconstructed heads at the target epoch.

This keeps retrieval consistent with the transaction digests (§4) without
hard-coding a specific hash function.

## Performance Notes

* `am_chunks` makes reconstruction **O(#changes since snapshot)** without decoding intermediate changes.
* Snapshot cadence (see §7) keeps this small even for long-lived branches.
* Indexing hot paths:

  * `(doc_id, branch_id, seq_no)` for range scans.
  * `(doc_id, branch_id, tx_id)` for epoch-based retrieval.
