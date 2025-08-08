# Background Tasks

- **Chunk builder**:
  - Watches for new commits; for each (doc,branch), loads last snapshot/chunk
    point, applies new changes, and writes `saveIncremental()` chunks aligned to
    `seq_no`.
- **Snapshotter**:
  - Triggers by thresholds (N changes / M bytes / time), builds `save()`
    snapshot and writes `am_snapshots`.
  - Retains last K snapshots per branch; vacuum occasionally.
- These are **pure caches**; can be rebuilt from `am_change_*` at any time.
