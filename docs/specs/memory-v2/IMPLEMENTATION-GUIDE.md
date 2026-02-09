# Memory v2 Implementation Guide

Process learnings from the v1 → v2 migration. These are ordering constraints,
testing strategies, and coordination patterns — not spec content.

---

## 1. Build Order

### 1.1 Remote transport before default switch

The default `memoryVersion` switch should be the LAST step, not an early
milestone. Rationale:

- Unit tests use `StorageManager.emulate()` (in-process, no server). These can
  pass with v2 long before the remote transport works.
- Integration tests use `StorageManager.open()` → `connect()` (WebSocket to a
  real server). These exercise an entirely different code path.
- Switching the default before remote transport is stable creates a gap where
  unit tests pass but integration tests fail — and the failures are hard to
  diagnose because the v2 remote transport has its own set of issues (see
  sections below).

**Recommended order:**
1. Core types + storage engine (local/in-process)
2. Protocol + sessions (local/in-process)
3. Runner integration (behind feature flag, unit tests)
4. Remote WebSocket transport (client + server)
5. Integration tests with remote transport (all must pass)
6. Switch default

### 1.2 Schema queries after basic subscriptions

The v2 server should support simple entity subscriptions first (select by ID or
wildcard), then add schema-guided graph queries (`graph.query` command) as a
follow-up. Reason: the wildcard subscription is correct and passes all tests.
Schema queries are an optimization, not a correctness requirement.

**Do not attempt client-side schema traversal as a substitute for server-side
schema queries.** Client-side traversal requires schemas that are often
unavailable (`schema: false`) and was architecturally backwards (see
`LEARNINGS.md` #1, #2).

---

## 2. Testing Strategy

### 2.1 Test both code paths

The runner has two distinct storage instantiation paths:

| Path | Method | Used by | Server? |
|------|--------|---------|---------|
| Emulator | `StorageManager.emulate()` | Unit tests | No (in-process) |
| Production | `StorageManager.open()` → `connect()` | Integration tests, shell | Yes (WebSocket) |

When adding a feature flag (like `memoryVersion`), both paths must be updated
and tested. A feature flag that only works in `emulate()` will cause silent
failures in production.

### 2.2 Integration test acceptance criteria

Four integration tests were pinned to v1 because they depend on server-side
schema queries (`/memory/graph/query`):

- `incremental-schema-query.test.ts`
- `sync-schema-path.test.ts`
- `pending-nursery.test.ts`
- `recipe-and-data-persistence.test.ts`

**These tests define "done" for v2 schema queries.** When the v2 server
implements `graph.query`, unpin these tests and verify they pass.

### 2.3 Run integration tests with real servers

Always use `scripts/start-local-dev.sh` to start dev servers for integration
testing. Key gotchas:

- **Don't use `deno task dev`** directly — it doesn't set `SHELL_URL`, `PORT`,
  and `API_URL` correctly.
- **Kill stale processes** before restarting: use `scripts/stop-local-dev.sh` or
  check `lsof -i :8000 -i :5173`.
- **Verify API_URL**: if the shell shows
  `API_URL=https://toolshed.saga-castor.ts.net/` instead of
  `http://localhost:8000/`, a stale process is running.

---

## 3. Common Pitfalls

### 3.1 Fire-and-forget writes

v1's synchronous server model makes fire-and-forget writes safe — the server
processes them before any subsequent read. v2's async remote transport breaks
this assumption: a write may not reach the server before a subsequent read from
a different client.

**Audit all `tx.commit()` calls that are not awaited.** Known instance:
`RecipeManager.saveRecipe()` fires `tx.commit()` without awaiting (a conflict-
handling hack). Fix: add `flush()` methods to await pending writes.

### 3.2 Assumed entity pre-loading

v1's server-side graph queries pre-fetch all related entities (including
process cell metadata like `$TYPE`). Code that reads related entities
immediately after syncing a root entity assumes this pre-loading happened.

In v2 (without graph queries), related entities are NOT pre-fetched. Code
like `processCell.key(TYPE).getRaw()` returns `undefined` because the linked
entity hasn't been synced yet.

**Fix pattern:** Explicit sync + retry loop for dependent entities.

### 3.3 URL construction

When constructing WebSocket URLs from base addresses, verify the final URL
doesn't have duplicate path segments. The base address may already include
`/api/storage/memory` — appending another `/api/storage/memory/v2` produces a
double path.

### 3.4 SQLite in browser WebWorkers

The v2 storage engine uses SQLite (via `@db/sqlite`), but the client runtime
runs in a browser WebWorker where SQLite is not available. Any client-side
storage component must have a non-SQLite path (e.g., `InMemoryShadow`).

Keep SQLite imports in platform-specific files (e.g., `cache.deno.ts`) and use
type-only imports in cross-platform code.

---

## 4. Coordination

### 4.1 Spec ↔ Implementation gap tracking

The spec (sections 01-06) describes the target design. Not all spec features are
implemented yet. Track the gap:

| Spec Feature | Status | Blocking? |
|-------------|--------|-----------|
| Simple queries (§5.2) | Implemented | No |
| Schema queries (§5.3) | **Not implemented** | Yes (4 pinned tests) |
| Simple subscriptions (§5.4.2) | Implemented | No |
| Schema-aware subscriptions (§5.4.3) | **Not implemented** | No (wildcard fallback works) |
| Point-in-time queries (§5.5) | Not implemented | No |
| Branching (§6) | Not implemented | No |
| Blob storage (§1 / §4.9) | Not implemented | No |
| Classification/redaction (§5.6) | Not implemented | No |

### 4.2 Notification rename

The internal event system was renamed from "subscription" to "notification"
terminology to distinguish from v2 data subscriptions:

| Old Name | New Name |
|----------|----------|
| `IStorageSubscription` | `IStorageNotificationSink` |
| `IStorageSubscriptionCapability` | `IStorageNotificationSource` |
| `StorageSubscription` class | `StorageNotificationRelay` |

This rename is currently in commit `5e7ae8376` alongside the (failed) traversal
attempt. The rename is clean and should be preserved when that commit is
reworked.
