# Snapshots & Chunking Policy

## am_chunks

* Store `saveIncremental()` output per applied change (or batches if you coalesce multiple changes).
* Makes rehydration O(#changes since snapshot) by concatenation only — no decoding/apply overhead.

## Snapshot Triggers (Configurable)

* Every **N changes** per branch (e.g., 500 changes).
* Or when **delta bytes since last snapshot > X MB** (e.g., 2–4 MB).
* Or **time-based** (e.g., branch updated after 24 h without a recent snapshot).

## Snapshot Procedure

1. Load latest snapshot for branch (if any).
2. Apply all outstanding changes.
3. Run `Automerge.save()` to produce full snapshot bytes.
4. Write a new row in `am_snapshots` with:

   * `upto_seq_no` = last applied `seq_no`
   * `heads_json` = JSON array of current heads
   * `root_hash` = BLAKE3 over sorted heads
   * `bytes` = full snapshot
   * `tx_id` and `committed_at`
5. Optionally prune old snapshots (keep last K snapshots per branch).
6. Periodically `VACUUM` to reclaim space after pruning.

## Space Management

* Snapshots and chunks are caches — they can be deleted and rebuilt from `am_change_blobs` + `am_change_index`.
