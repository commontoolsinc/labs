# New storage backend migrations and rollback

This document describes the migration for performance indexes and WS delivery hardening added in this iteration.

What changed
- Added indexes to speed up hot queries discovered via EXPLAIN QUERY PLAN:
  - am_change_index
    - idx_change_actor_seq(branch_id, actor_id, seq_no)
    - idx_change_branch_hash(branch_id, change_hash)
    - idx_change_seq_range(doc_id, branch_id, seq_no)
  - subscription_deliveries
    - idx_subscription_deliveries_seq(subscription_id, delivery_no)
- Introduced bounded queue and backpressure for WebSocket deliveries
  - Bounded per-subscription unacked rows to MAX_DELIVERY_QUEUE (1000) with oldest-drop policy.
  - Sender loop batches (LIMIT 100) and observes socket bufferedAmount before sending more.

Forward migration
- Apply SQL migration 004_perf_indexes.sql on each space database:
  - Location: packages/storage/src/sqlite/migrations/004_perf_indexes.sql
  - This is idempotent (IF NOT EXISTS), safe to re-run.
- No schema changes to existing tables aside from indexes.
- WebSocket delivery behavior changes do not require DB migration beyond indexes.

Rollback
- To roll back indexes, you may drop them explicitly:
  - DROP INDEX IF EXISTS idx_change_actor_seq;
  - DROP INDEX IF EXISTS idx_change_branch_hash;
  - DROP INDEX IF EXISTS idx_change_seq_range;
  - DROP INDEX IF EXISTS idx_subscription_deliveries_seq;
- To revert WS delivery behavior, set MAX_DELIVERY_QUEUE to previous effectively-unbounded behavior (not recommended) and remove batch/pressure checks in ws handler. No DB changes are required.

Operational notes
- Single-writer model: The storage pipeline uses BEGIN IMMEDIATE, which enforces a single writer per space DB. See tests for concurrent hammer verification.
- After deploying, consider running ANALYZE on each DB to refresh index statistics.

Verification
- Run integration tests:
  - deno test -A packages/storage/integration/subscriptions.test.ts
- Optional: Run a concurrent hammer script issuing ~100 transactions to ensure no deadlocks and expected conflicts are surfaced. A sample test will be added under packages/storage/test.

