-- 004_perf_indexes.sql
-- Add indexes discovered via EXPLAIN QUERY PLAN on hot paths

-- am_change_index lookups by (branch_id, actor_id ORDER BY seq_no)
CREATE INDEX IF NOT EXISTS idx_change_actor_seq ON am_change_index(branch_id, actor_id, seq_no);

-- am_change_index lookups by (branch_id, change_hash)
CREATE INDEX IF NOT EXISTS idx_change_branch_hash ON am_change_index(branch_id, change_hash);

-- am_change_index range scans by (doc_id, branch_id, seq_no)
CREATE INDEX IF NOT EXISTS idx_change_seq_range ON am_change_index(doc_id, branch_id, seq_no);

-- subscription_deliveries sequential send and resume by (subscription_id, delivery_no)
CREATE INDEX IF NOT EXISTS idx_subscription_deliveries_seq ON subscription_deliveries(subscription_id, delivery_no);

