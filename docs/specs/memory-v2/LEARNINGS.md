# Memory v2 Implementation Learnings

This document captures things we got confused about, realized late, or should
have understood before starting implementation. It's intended to serve as input
for a revised plan that starts from a more complete understanding.

---

## 1. Schema traversal happens SERVER-SIDE in v1, not client-side

**What we assumed:** That `SchemaObjectTraverser` from `traverse.ts` could be
used on the client to discover linked entities after data arrives, then expand
subscriptions to include those entities.

**What's actually true:** In v1, the server-side `selectSchema()` function in
`packages/memory/space-schema.ts` does the schema-guided graph traversal. The
server walks from root entities through references, guided by the JSON schema,
and returns ALL linked entities in a single query response. The client never
needs to "discover" linked entities — the server already includes them.

The client-side `SchemaObjectTraverser` usage in `schema.ts` is for
**validating and transforming** already-loaded data, not for discovering what to
subscribe to.

**Impact:** Our plan tried to replicate v1's server-side behavior on the
client. This was backwards. The v2 protocol currently only supports simple
entity subscriptions (`select: { "id": {} }`), not schema-guided graph queries.
The proper approach is either:
  1. Implement schema queries on the v2 server (matching the spec in
     `05-queries.md` §5.3), or
  2. Use a simpler client-side expansion strategy that doesn't depend on
     schemas.

## 2. Most cells have `schema: false`, making schema traversal useless

**What we assumed:** That cells always have meaningful JSON schemas available
for traversal.

**What's actually true:** In `cache.ts:2226`, the selector is built as:
```typescript
const selector = {
  path: cell.path.map((p) => p.toString()),
  schema: schema ?? false,
};
```
When `cell.getAsNormalizedFullLink()` returns no schema (which is common —
many cells don't carry schemas), the selector gets `schema: false`.

Per both the v2 spec (`05-queries.md` §5.3.2 line 167) and the traverse.ts
implementation, `schema: false` means "reject — skip this subtree." A traverser
with `schema: false` will not follow any references, discover any linked
entities, or traverse any sub-paths.

**Impact:** Even if client-side traversal were correct in principle, it would
be a no-op for the majority of cells. The wildcard subscription is needed as
a fallback, or schemas must be made universally available.

## 3. v1 storage envelope: data is wrapped as `{ value: actualData }`

**What we should have documented early:** v1 stores entity data in an envelope
format where the actual cell value lives at the `value` key:
```json
{ "value": { "count": 0, "label": "Counter" } }
```

This means:
- Fact paths include `"value"` prefix: `["value", "items", "0"]`
- `readValueOrThrow()` automatically prepends `"value"` to the path
- `SchemaPathSelector.path` in v1 queries always starts with `"value"`
  (e.g., `["value", ...cell.path]`)
- Cell paths (`cell.path`) are relative to the value, NOT the envelope

When adapting v1 code (traverse.ts) for v2, path rerooting is needed. The
traverser expects paths relative to the envelope root, but v2 localState
stores raw values without the envelope.

**What we got wrong:** The initial `discoverLinkedEntities()` implementation
set `rootDoc.address.path = ["value"]` with `value: rootState.is`, causing
"Doc path should never exceed selector path" errors. The fix required:
- Doc address `path: []` (envelope root)
- Doc value `{ value: rootState.is }` (reconstructed envelope)
- Selector path rerooted to `["value", ...cell.path]`

## 4. `ManagedStorageTransaction` interface gaps

**What we discovered during type checking:**
- `ManagedStorageTransaction` doesn't have a `changeGroup` property, even
  though `IExtendedStorageTransaction` expects it. Our adapter needed a
  getter returning `undefined` and a no-op setter.
- `result.error` can be `undefined` even after an `'error' in result` check,
  requiring an extra `&& result.error` guard.

These are minor but would have been caught earlier with a careful interface
audit before implementation.

## 5. `queueMicrotask` batching breaks `synced()` timing

**What we built:** `setupSubscription()` uses `queueMicrotask` to batch
multiple subscription calls into one consolidated subscription update.

**What went wrong:** `synced()` is called immediately after `sync()`, before
the microtask runs. This means `synced()` sees an empty `pendingReady` array
and returns immediately, before any subscriptions are created or any data is
loaded.

**What we should have done:** Either:
- Use synchronous batching with an explicit flush point (called from `synced()`)
- Skip microtask batching entirely and consolidate at the subscription protocol
  level
- Document that `synced()` must flush pending microtasks before checking readiness

## 6. v2 server doesn't implement schema queries yet

**What the spec says:** `05-queries.md` §5.3 defines `SchemaQuery` with
`selectSchema: SchemaSelector` — the server should walk entity graphs guided by
schemas, exactly like v1's `space-schema.ts` → `selectSchema()` function.

**What's implemented:** The v2 protocol (`packages/memory/v2/protocol.ts`) only
supports simple `subscribe` with `select: Record<EntityId, {}>` — flat entity
ID matching. There's no `selectSchema` command in the v2 protocol.

**Why this matters:** Without server-side schema queries, the client must either
use wildcard `{ "*": {} }` (current approach — fetches everything) or implement
its own entity discovery (our failed attempt). The proper long-term fix is to
implement schema queries in the v2 server.

## 7. Linked entities in the cell framework

**How cells store nested data:** The cell framework stores complex nested
objects as separate entities linked by `{"/": id}` references. For example, a
recipe cell might look like:
```json
{
  "value": {
    "name": "counter",
    "program": { "/": "entity-id-for-program" }
  }
}
```
Where `entity-id-for-program` is a separate entity containing:
```json
{
  "value": {
    "files": { "/": "entity-id-for-files" }
  }
}
```

**Why this matters for subscriptions:** Subscribing to just the root entity
gives you the top-level object with unresolved `{"/": id}` references. You
need to also subscribe to all transitively linked entities. v1 handles this
server-side (see point 1). v2 currently uses wildcard to work around this.

## 8. The wildcard subscription works but is O(space)

**Current state:** After the Phase 4e fix (`219c41358`), v2 uses a single
wildcard `{ "*": {} }` subscription per space. This correctly fetches all
entities, including transitively linked ones.

**The cost:** Every entity write in the space triggers a notification to every
subscriber of that space, even if the write is irrelevant. For spaces with
many independent cells, this is O(n) per write where n = total entities.

**When this matters:** It doesn't matter yet for small/medium spaces. It will
matter when spaces have thousands of entities and many concurrent subscribers.

## 9. The `doStart()` process cell sync issue

**Root cause:** v1's `query()` with schema traversal prefetches all related
entities (including process cell metadata like `$TYPE`). v2's per-entity
subscription doesn't. So when `runner.ts` calls `processCell.key(TYPE).getRaw()`,
the process cell's linked entities aren't loaded yet.

**Fix applied in Phase 4e:** Added explicit `sync()` + `synced()` for the
process cell in `doStart()`, with a retry loop.

**Deeper lesson:** Any code path that assumes "related entities are already
loaded" after syncing a root entity will break in v2. This assumption is baked
into the v1 mental model (server-side graph traversal loads everything) and
needs to be systematically identified.

## 10. Recipe metadata is fire-and-forget in v1

**What we found in Phase 4d:** `RecipeManager.saveRecipe()` calls
`tx.commit()` without awaiting it — a deliberate hack for conflict handling.
With v2 remote transport (async server confirmation), recipe metadata may not
reach the server before another client reads it.

**Fix:** Added `RecipeManager.flush()` to await pending recipe commits.

**Lesson:** Any fire-and-forget writes that worked in v1 (where the server
is the source of truth and queries are synchronous) can fail in v2 (where
writes are locally optimistic but server confirmation is async).

## 11. v2 References are branded objects, not plain strings

**What bit us in Phase 3 (`8980987cb`):** The v2 storage engine returns
commit hashes as plain strings (e.g., `"baedrei..."`), but v1's fact
normalization code expects `Reference` objects from merkle-reference (branded
`View` types). Passing a string where a Reference was expected caused
TypeErrors deep in fact processing.

**Fix:** `toV1Cause()` helper that wraps v2 hash strings into proper v1
Reference objects using `fromJSON({ "/": hash })`.

**Later gotcha (`393f304bf`):** When References cross the JSON wire (WebSocket),
they arrive as `{"/": "baedrei..."}` objects, not as branded References. The
initial fix used `fromString()` which expects the raw hash string, but the
deserialized wire format needs `fromJSON()` which expects the `{"/": ...}`
wrapper. This caused a second round of "Reference not recognized" errors
during remote transport integration.

**Lesson:** Reference serialization has three formats that must be handled:
1. In-memory branded `Reference` object (v1 internal)
2. Plain hash string (v2 storage engine output)
3. JSON-serialized `{"/": "hash"}` (wire protocol)

## 12. v2 subscription fires synchronously during transact

**What we missed initially (`1ccbe53b3`):** In v1, subscription notifications
come from the server asynchronously. In v2, `ConsumerSession.transact()` fires
subscription callbacks synchronously within the same call stack as the
transaction.

**Why this mattered:** The v2 provider calls `consumer.transact()`, which
fires the subscription listener, which calls `handleSubscriptionUpdate()`,
which fires `notifications.next()` to the scheduler. But we ALSO fire
`notifications.next()` after `transact()` returns. This caused **double
notifications** for every own write.

**Fix:** `suppressSubscriptionUpdates` flag — set to `true` before calling
`consumer.transact()`, checked in the subscription handler, reset after.

**Lesson:** When wrapping a library that fires callbacks synchronously,
you need to understand the call stack implications. v1's async notification
model hid this entirely.

## 13. `IMergedChanges` must contain actual before/after diffs

**What broke (`1ccbe53b3`):** The initial v2 provider sent empty `changes`
arrays in subscription notifications. The scheduler uses `IMergedChanges` to
determine which cells are affected by a commit and need re-evaluation. Empty
changes = scheduler thinks nothing changed = no reactive updates.

**Fix:** `makeChange()`/`asChanges()` helpers that compute entity-level diffs
by comparing localState before and after a transaction.

**Lesson:** The scheduler's reactivity model is not "re-evaluate everything
on any commit." It's "re-evaluate cells whose entities appear in the
`IMergedChanges`." Any v2 provider that skips building proper change records
will silently break reactivity.

## 14. `undefined` values crash `refer()` (merkle-reference)

**What happened (`94b2b65b5`):** JavaScript objects often contain `undefined`
values (e.g., `{ a: 1, b: undefined }`). v1's `Provider.send()` does a JSON
roundtrip to strip them before storage. The initial v2 provider skipped this
step, causing `refer()` to throw when computing content hashes.

**Fix:** JSON roundtrip (`JSON.parse(JSON.stringify(value))`) before passing
values to v2 storage, matching v1's behavior.

**Lesson:** The v2 storage engine inherits merkle-reference's strict value
requirements. Any data entering v2 must be JSON-clean (no `undefined`, no
non-JSON types).

## 15. Cross-session subscription isolation

**What we discovered (`7b171a7df`):** Each `ProviderSession` in the v2 server
had its own `SubscriptionManager`. When client A wrote to a space via session 1,
client B's subscription on session 2 never fired — because session 2's
`SubscriptionManager` didn't know about session 1's commit.

**Fix:** `SpaceV2.onCommit(listener)` — a space-level listener mechanism that
notifies ALL sessions sharing a space about every commit, not just the
committer's session.

**Lesson:** In v1, the server uses a single shared space object with one
subscription mechanism. v2's session-per-connection model needed explicit
cross-session notification wiring that wasn't in the original design.

## 16. InMemoryShadow vs SQLite in browser WebWorkers

**What we discovered (`7b171a7df`):** The initial `RemoteConsumer` used a full
`SpaceV2 + ProviderSession + ConsumerSession` chain for local shadow state.
This pulled in `@db/sqlite` which doesn't work in browser WebWorkers.

**Fix:** `InMemoryShadow` — a minimal in-memory implementation that replaces
the entire chain. It stores entities in a `Map<string, Revision<State>>` and
tracks a monotonic version counter.

**Lesson:** The v2 storage engine was designed around SQLite, but the client
runtime runs in a WebWorker where SQLite isn't available. Any client-side
storage component must have a non-SQLite path. This should have been a
constraint in the original design.

## 17. Production vs emulator code paths diverge

**What we found (`e0c91c8e1`):** After switching the default to v2 and
verifying all unit tests pass, integration tests still failed because the
production `StorageManager.connect()` (in base `cache.ts`) didn't respect
the `memoryVersion` flag. Only the `emulate()` path did.

**This happened because:** Unit tests use `StorageManager.emulate()` (in-
process, no server), while integration tests use `StorageManager.open()` →
`connect()` (WebSocket to real server). The two code paths are in different
classes (`DenoStorageManager` vs base `StorageManager`) and had to be updated
independently.

**Lesson:** When adding a feature flag, grep for ALL code paths that
instantiate the affected components — not just the one exercised by unit tests.

## 18. Four integration tests are pinned to v1 (schema queries not in v2)

**Committed in `595b302b6`:** These integration tests depend on the v1
server's `/memory/graph/query` with `selectSchema` (graph traversal):
- `incremental-schema-query.test.ts` — tests that new links are discovered
  via schema traversal after initial load
- `sync-schema-path.test.ts` — tests schema-guided path sync
- `pending-nursery.test.ts` — uses v1 nursery concepts
- `recipe-and-data-persistence.test.ts` — uses graph query for persistence

**These tests define the acceptance criteria for "v2 schema queries done."**
When the v2 server supports schema queries, unpin these tests and verify they
pass.

## 19. Double URL path bug in remote connection

**What happened (`393f304bf`):** `StorageManager.connect()` constructed the
WebSocket URL by appending `/api/storage/memory/v2` to the base address, which
already included `/api/storage/memory`. Result: `/api/storage/memory/api/storage/memory/v2`.

**Lesson:** When constructing URLs from parts, always verify the final URL
doesn't have duplicate path segments. Print the actual URL early in debugging.

## 20. The "default switch" was premature — should wait for remote transport

**Timeline:**
1. `0f4aa2946` — Switch default to v2 (unit tests pass, but no remote)
2. `e0c91c8e1` — Discover production code ignores the flag
3. `2b9e303f6` — Build remote WebSocket transport
4. `393f304bf`→`219c41358` — Five fix commits for remote issues

**What happened:** We switched the default to v2 before remote transport
existed, based on unit tests passing. Then we had to build remote transport
urgently, discovering many issues (cross-session subscriptions, initial state
loading, recipe flush, wildcard subscription, process cell sync) that required
a stream of fixes.

**Better approach:** Build and stabilize remote transport FIRST, then switch
the default. The default switch should be the capstone, not the starting gun.

---

## Summary of what a revised plan should address

### Architecture

1. **Don't try client-side schema traversal for subscription expansion.** The
   schemas aren't reliably available (`schema: false`), and the traversal code
   is designed for server-side use with already-loaded data.

2. **Keep wildcard subscription as the working baseline.** It's correct and
   all integration tests pass with it.

3. **The proper optimization path is server-side schema queries in v2.** This
   matches the spec (§5.3), reuses the same `selectSchema()` code that v1
   uses, and doesn't require schemas on the client.

4. **Before implementing server-side schema queries, consider whether simple
   reference-following (without schemas) might be sufficient.** The v2 server
   could walk `{"/": id}` links in entity values to discover linked entities
   without needing a schema at all. This would be a simpler first step.

5. **The notification rename (Part 2) was clean and should be kept.** No issues
   there.

6. **Ensure `synced()` semantics are well-defined.** Whatever batching strategy
   is used for subscriptions, `synced()` must wait for all pending data to arrive,
   including data triggered by cascading reference discovery.

### Process

7. **Build remote transport before switching defaults.** The default switch
   should be the last step, after remote transport is stable with all
   integration tests passing. (See learning #20.)

8. **Test both emulate AND production code paths** when adding feature flags.
   Unit tests only exercise `emulate()`. Integration tests exercise
   `connect()`. Both must be updated. (See learning #17.)

9. **Unpin tests define "done" for schema queries.** The 4 integration tests
   pinned to v1 (`595b302b6`) are the acceptance criteria. (See learning #18.)

### Data model

10. **Three Reference formats exist** — branded in-memory, plain hash string,
    and JSON `{"/": hash}` wire format. All three must be handled in any
    code that crosses process boundaries. (See learning #11.)

11. **Scheduler reactivity requires populated `IMergedChanges`.** Empty changes
    = no reactive updates. Any new storage provider must compute proper
    before/after diffs. (See learning #13.)

12. **Client-side storage must work without SQLite.** The WebWorker environment
    doesn't support `@db/sqlite`. Any client-side shadow state needs an
    in-memory fallback. (See learning #16.)
