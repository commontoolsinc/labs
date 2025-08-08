# Migration / Bootstrap

1. Create per-space DB & tables; run PRAGMAs.
2. Seed `docs` and `branches` (e.g., `main` branches).
3. For existing Automerge files: import as one `am_snapshot` (seq 0) or split
   into `am_change_blobs` + `am_change_index` with synthetic tx.
