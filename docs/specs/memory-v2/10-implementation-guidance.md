# Implementation Guidance: Seq Revisions and Session Watch Sync

This document supplements sections 01-06 of the Memory v2 spec. It describes the
intended implementation target for the current rewrite, not the earlier
hash/fact/subscription prototype.

If this file conflicts with sections 01-06, update the file. Do not preserve
older guidance by layering compatibility code around it.

## 1. Source Of Truth

Implementation authority is:

1. sections 01-06 of this spec
2. this guidance file
3. the focused v2 tests
4. the current runtime-facing public interfaces

Do not revive old `commit.hash`, `fact.hash`, `value_ref`,
`graph.query subscribe`, or subscription-id routing because they existed in the
previous implementation.

## 2. Clean Break Rules

- Use a new engine root: `engine-v3` / `.engine-v3`.
- Do not migrate or read the current v2 SQLite files in place.
- Do not keep the old live wire protocol alongside the new one.
- Keep blob payload storage content-addressed; drop semantic hashes only from
  the JSON entity path.

## 3. Transport Target

This pass keeps the lightweight WebSocket framing already used by the current
codebase. The target wire messages are:

- `hello`
- `hello.ok`
- `session.open`
- `transact`
- `graph.query`
- `session.watch.set`
- `session.ack`
- `response`
- `session/effect`

Do not switch this pass to full UCAN message framing. Persist invocation/auth
data for write-class commands only.

## 4. Session Model

Use a logical session per space. The session owns:

- `sessionId`
- `seenSeq`
- retained outstanding commits keyed by `localSeq`
- the current watch set
- the current watch-union result known to the server

Reconnect behavior:

1. re-open the session with `sessionId` and `seenSeq`
2. replay outstanding commits in `localSeq` order
3. reinstall the watch set
4. integrate catch-up sync newer than `seenSeq`

The client should treat `seenSeq` as “highest canonical seq fully integrated
into confirmed state,” not merely “latest seq observed on the wire.”

## 5. Transaction Contract

The runner-facing transaction contract does not change.

`IExtendedStorageTransaction.commit()` still has two phases:

1. synchronous local apply
2. asynchronous server resolution

The storage-visible notification behavior must remain:

- optimistic `"commit"` before the async round trip completes
- `"revert"` synchronously before the promise resolves on conflict
- `"integrate"` for remote sync

## 6. Stable Snapshot Rule

A transaction must be authored against one stable local snapshot.

- Do not apply incoming sync frames to confirmed state in the middle of building
  a transaction.
- Buffer incoming sync while a transaction is reading and writing.
- Apply buffered sync after the transaction has been submitted.

This rule is required so `reads.confirmed` and `reads.pending` describe one
coherent snapshot.

## 7. Commit Identity and Storage Identity

Use these identities consistently:

- pending commit identity: `(sessionId, localSeq)`
- canonical commit identity: `seq`
- persisted revision identity: `(branch, id, seq, opIndex)`

`seq` identifies the accepted transaction. `opIndex` identifies the specific
stored revision row when one commit writes multiple operations.

## 8. Engine Schema

Use a seq/revision schema, not a hash/fact schema.

Required persistent concepts:

- `commit`
- `revision`
- `head`
- `snapshot`
- `branch`
- `invocation`
- `authorization`
- `blob_store`

Required properties:

- `commit` has no semantic hash column
- `revision.data` stores inline JSON document payloads or patch arrays
- `head` points at `(seq, op_index)` for the current entity state
- `snapshot.value` stores inline full JSON document values
- `(session_id, local_seq)` remains unique for idempotent replay

## 9. Read Path

Current and point-in-time reads should use:

- direct head lookup for the latest state
- latest snapshot at or before the requested seq
- revision replay from that snapshot boundary

Do not rebuild JSON entity history through parent hashes.

Patch replay rules stay conservative:

- `set` and `delete` replace the current base state
- `patch` replays on top of the latest base/snapshot
- confirmed-read conflicts remain path-aware

## 10. Watch Sets And Sync

The server should not route live updates through the original watch request id.

Instead:

- each session owns the full current watch set
- the server computes the union of watched entities for that session
- the server emits `session/effect` sync frames for the union

Practical guidance:

- watch overlap should dedupe at the session cache layer
- `removes` mean “no longer relevant to this watch union,” not tombstone
- keep one-shot `graph.query` for non-live reads and shared traversal logic

Before returning a `ConflictError`, flush any already-committed relevant sync so
the client can retry on fresh watched state.

## 11. Query / Traversal Reuse

Keep using the shared traversal code from `packages/runner/src/traverse.ts`.

The server and client must continue to agree on entity reachability and graph
membership. Reuse traversal logic rather than reimplementing a separate graph
expander in storage code.

## 12. Branch Scope

This pass includes basic branches only:

- branch create/delete/list
- branch-aware writes
- branch-aware current reads
- branch-aware point-in-time reads
- branch-aware watch scopes

Defer merge proposal generation and advanced branch live-sync behavior. Do not
block the seq/revision rewrite on merge ergonomics.

## 13. Testing Strategy

Drive the rewrite with focused red/green TDD.

For each implementation slice:

1. write or update the focused failing test first
2. make the minimal production change needed to turn it green
3. clean up only after the test is passing

Do not batch large speculative rewrites and add tests afterward. If a behavior
matters enough to preserve or change, capture it in a failing test before
changing the implementation.

Required test areas:

- new engine-root path resolution
- revision replay and snapshots
- idempotent `(sessionId, localSeq)` replay
- session watch installation and catch-up sync
- reconnect with outstanding commits
- runner notification ordering
- toolshed end-to-end sync on the new protocol

Keep the runner/storage public surface stable in tests. If a test only probes
old v2 internals that are being deleted, rewrite or remove it instead of
restoring the deleted behavior.

## 14. Anti-Patterns

Do not:

- reintroduce hash-addressed JSON facts as an internal compatibility layer
- keep both subscription-id updates and session sync at once
- tie live updates to the invocation or request that created a watch
- compare confirmed duplicates by `(seq, hash)` after hashes are gone
- silently fall back from the new engine root to the old one
- spread branch support across special cases instead of carrying branch through
  the core read/write path
