# Changelog

## Unreleased

New storage backend (flagged)
- Added SQLite-backed Automerge storage provider with:
  - Heads processing (deps subset validation, per-actor seq monotonicity)
  - PIT reads with snapshot fast path and chunk fallback
  - Snapshot cadence (default every 5 changes), stored in am_snapshots/am_chunks
  - Branch management (create/close), client-merge support; optional server-merge flag
  - Content-addressed primitives for changes and snapshots
  - Query IR and basic evaluator with traversal and budgeting
  - Minimal UCAN validation for read/write caps
- Toolshed routes under /api/storage/new/v1 mounted when ENABLE_NEW_STORAGE=1
- CLI tasks for listing spaces/branches and importing/exporting snapshots

Migration instructions
- Enable routes: set ENABLE_NEW_STORAGE=1 when running Toolshed
- Apply performance indexes: run packages/storage/src/sqlite/migrations/004_perf_indexes.sql on each space DB (idempotent)
- Optional: import existing Automerge snapshots with the CLI to seed PIT fast path

Feature flags (defaults)
- ENABLE_NEW_STORAGE=0 — off by default; set to 1 to enable new routes
- ENABLE_SERVER_MERGE=0 — off by default; enables server-side merge synthesis when set to 1

Notes
- API is documented in docs/specs/storage/03-api.md
- PIT, snapshots, branching, tx processing, invariants in docs/specs/storage/*
- Quick migration guide: docs/storage/new-backend-migrations.md
