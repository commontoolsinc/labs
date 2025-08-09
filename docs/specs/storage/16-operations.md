# Operational Guidance

- **Throughput**: WAL mode, single-writer SQLite handles hundreds of small
  changes/sec. Batch changes when possible.
- **Backups**: hot WAL backups per space DB.
- **Vacuum**: periodically to reclaim space after pruning snapshots.
- **Observability**: log tx latency, error counts, WS backlog sizes.
- **Indices**:

  - `am_change_index(doc_id, branch_id, seq_no)` → exact range scans
  - `am_change_index(doc_id, branch_id, tx_id)` → catch-up queries
  - `am_heads(branch_id)` → single row lookup
