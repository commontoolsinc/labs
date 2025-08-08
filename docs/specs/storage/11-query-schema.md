# Query Schema Extensions

## Query Subscriptions Table

```sql
CREATE TABLE query_subscriptions (
  query_id TEXT PRIMARY KEY,
  space_did TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  json_path TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  max_link_depth INTEGER NOT NULL DEFAULT 3,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_evaluated_at TEXT,
  root_verdict TEXT CHECK (root_verdict IN ('Yes', 'No', 'MaybeExceededDepth')),
  FOREIGN KEY(space_did) REFERENCES spaces(space_did) ON DELETE CASCADE
);
CREATE INDEX idx_query_subscriptions_space ON query_subscriptions(space_did);
CREATE INDEX idx_query_subscriptions_doc ON query_subscriptions(doc_id);
```

## IR Cache Table

```sql
CREATE TABLE query_ir_cache (
  ir_node_id TEXT PRIMARY KEY,
  ir_json TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  ref_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_ir_cache_hash ON query_ir_cache(hash);
CREATE INDEX idx_ir_cache_refcount ON query_ir_cache(ref_count);
```

## Schema Definitions Table

```sql
CREATE TABLE query_schema_definitions (
  schema_hash TEXT NOT NULL,
  definition_name TEXT NOT NULL,
  ir_node_id TEXT NOT NULL,
  PRIMARY KEY(schema_hash, definition_name),
  FOREIGN KEY(ir_node_id) REFERENCES query_ir_cache(ir_node_id) ON DELETE CASCADE
);
CREATE INDEX idx_schema_definitions_schema ON query_schema_definitions(schema_hash);
CREATE INDEX idx_schema_definitions_ir ON query_schema_definitions(ir_node_id);
```

## Evaluation Cache Table

```sql
CREATE TABLE query_eval_cache (
  eval_key_hash TEXT PRIMARY KEY,
  ir_node_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  path_json TEXT NOT NULL,  -- JSON array of strings
  link_budget INTEGER NOT NULL,
  ref_depth INTEGER NOT NULL DEFAULT 0,  -- Track reference depth for cycle detection
  verdict TEXT NOT NULL CHECK (verdict IN ('Yes', 'No', 'MaybeExceededDepth')),
  touches_json TEXT NOT NULL,  -- JSON array of {doc, path} objects
  link_edges_json TEXT NOT NULL,  -- JSON array of {from, to} objects
  deps_json TEXT NOT NULL,  -- JSON array of eval_key_hash strings
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(ir_node_id) REFERENCES query_ir_cache(ir_node_id) ON DELETE CASCADE
);
CREATE INDEX idx_eval_cache_ir ON query_eval_cache(ir_node_id);
CREATE INDEX idx_eval_cache_doc ON query_eval_cache(doc_id);
CREATE INDEX idx_eval_cache_last_used ON query_eval_cache(last_used_at);
```

## Provenance Index Tables

```sql
CREATE TABLE query_link_touches (
  doc_id TEXT NOT NULL,
  path_json TEXT NOT NULL,  -- JSON array of strings
  eval_key_hash TEXT NOT NULL,
  PRIMARY KEY(doc_id, path_json, eval_key_hash),
  FOREIGN KEY(eval_key_hash) REFERENCES query_eval_cache(eval_key_hash) ON DELETE CASCADE
);
CREATE INDEX idx_link_touches_link ON query_link_touches(doc_id, path_json);
CREATE INDEX idx_link_touches_eval ON query_link_touches(eval_key_hash);
```

```sql
CREATE TABLE query_eval_deps (
  parent_eval_key_hash TEXT NOT NULL,
  child_eval_key_hash TEXT NOT NULL,
  PRIMARY KEY(parent_eval_key_hash, child_eval_key_hash),
  FOREIGN KEY(parent_eval_key_hash) REFERENCES query_eval_cache(eval_key_hash) ON DELETE CASCADE,
  FOREIGN KEY(child_eval_key_hash) REFERENCES query_eval_cache(eval_key_hash) ON DELETE CASCADE
);
CREATE INDEX idx_eval_deps_parent ON query_eval_deps(parent_eval_key_hash);
CREATE INDEX idx_eval_deps_child ON query_eval_deps(child_eval_key_hash);
```

## Subscription Dependencies

```sql
CREATE TABLE query_subscription_links (
  query_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  path_json TEXT NOT NULL,  -- JSON array of strings
  PRIMARY KEY(query_id, doc_id, path_json),
  FOREIGN KEY(query_id) REFERENCES query_subscriptions(query_id) ON DELETE CASCADE
);
CREATE INDEX idx_subscription_links_query ON query_subscription_links(query_id);
CREATE INDEX idx_subscription_links_link ON query_subscription_links(doc_id, path_json);
```

```sql
CREATE TABLE query_subscription_evals (
  query_id TEXT NOT NULL,
  eval_key_hash TEXT NOT NULL,
  PRIMARY KEY(query_id, eval_key_hash),
  FOREIGN KEY(query_id) REFERENCES query_subscriptions(query_id) ON DELETE CASCADE,
  FOREIGN KEY(eval_key_hash) REFERENCES query_eval_cache(eval_key_hash) ON DELETE CASCADE
);
CREATE INDEX idx_subscription_evals_query ON query_subscription_evals(query_id);
CREATE INDEX idx_subscription_evals_eval ON query_subscription_evals(eval_key_hash);
```

## Link Index

```sql
CREATE TABLE query_incoming_links (
  target_doc_id TEXT NOT NULL,
  source_doc_id TEXT NOT NULL,
  source_path_json TEXT NOT NULL,  -- JSON array of strings
  PRIMARY KEY(target_doc_id, source_doc_id, source_path_json)
);
CREATE INDEX idx_incoming_links_target ON query_incoming_links(target_doc_id);
CREATE INDEX idx_incoming_links_source ON query_incoming_links(source_doc_id, source_path_json);
```

## Query Notifications

```sql
CREATE TABLE query_notifications (
  notification_id TEXT PRIMARY KEY,
  query_id TEXT NOT NULL,
  tx_id INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('root-verdict-changed', 'touch-set-expanded', 'touch-set-shrunk', 'touched-doc-updated')),
  docs_to_refresh_json TEXT NOT NULL,  -- JSON array of doc IDs
  summary_json TEXT NOT NULL,  -- JSON object with oldVerdict, newVerdict, deltaTouched
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at TEXT,
  FOREIGN KEY(query_id) REFERENCES query_subscriptions(query_id) ON DELETE CASCADE,
  FOREIGN KEY(tx_id) REFERENCES tx(tx_id) ON DELETE CASCADE
);
CREATE INDEX idx_query_notifications_query ON query_notifications(query_id);
CREATE INDEX idx_query_notifications_tx ON query_notifications(tx_id);
CREATE INDEX idx_query_notifications_unsent ON query_notifications(sent_at) WHERE sent_at IS NULL;
```

## GC and Maintenance

```sql
-- Clean up unused IR nodes
DELETE FROM query_ir_cache WHERE ref_count = 0;

-- Clean up old evaluation cache entries (LRU)
DELETE FROM query_eval_cache 
WHERE last_used_at < datetime('now', '-1 hour')
AND eval_key_hash NOT IN (
  SELECT DISTINCT eval_key_hash FROM query_subscription_evals
);

-- Clean up old notifications
DELETE FROM query_notifications 
WHERE created_at < datetime('now', '-24 hours');
```
