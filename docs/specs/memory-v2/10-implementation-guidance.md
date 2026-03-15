# Implementation Guidance: Wiring v2 Into Production

This document supplements the v2 spec (01-06) with architectural guidance and
known pitfalls. It is written for an agent that has ONLY the spec and this
document — no access to prior v2 wiring code. Read this before writing any code.

---

## Process: Red/Green TDD

Use **red/green test-driven development** throughout. For every new behavior:

1. **Red**: Write a failing test that describes the expected behavior.
2. **Green**: Write the minimum code to make the test pass.
3. **Refactor**: Clean up without changing behavior.

This applies at every level:

- Server handlers: write integration tests for each endpoint first
- Provider: write unit tests for commit/revert/integrate notification timing
  before implementing the provider
- Transaction: write tests for the two-phase commit contract before building the
  transaction adapter
- Pipelining: write a test that stacks two commits, then implement
- Parallel test: the randomized v1/v2 comparison test IS the red test for the
  entire v2 stack — get it to green

Do not write large amounts of untested code. Each increment should be a failing
test followed by the code that makes it pass.

---

## Table of Contents

0. [Process: Red/Green TDD](#process-redgreen-tdd)
1. [Architecture Overview](#1-architecture-overview)
2. [Naming and Interface Changes](#2-naming-and-interface-changes)
3. [V1/V2 Coexistence](#3-v1v2-coexistence)
4. [IExtendedStorageTransaction.commit() Contract](#4-iextendedstorageTransactioncommit-contract)
5. [Notification Model](#5-notification-model)
6. [Pending State and Pipelining](#6-pending-state-and-pipelining)
7. [Confirmed Reads: Version-Based Only](#7-confirmed-reads-version-based-only)
8. [Server-Side Parent Resolution](#8-server-side-parent-resolution)
9. [Schema-Driven Queries and traverse.ts](#9-schema-driven-queries-and-traversets)
10. [Wire Format and Signing](#10-wire-format-and-signing)
11. [ACL and Space Initialization](#11-acl-and-space-initialization)
12. [Emulation Mode](#12-emulation-mode)
13. [Patch Operations](#13-patch-operations)
14. [Randomized V1/V2 Parallel Test](#14-randomized-v1v2-parallel-test)
15. [Integration Testing](#15-integration-testing)
16. [Phasing](#16-phasing)
17. [Gotchas](#17-gotchas)
18. [Anti-Patterns](#18-anti-patterns)
19. [Minimal Transaction Compatibility Surface](#19-minimal-transaction-compatibility-surface)
20. [Raw vs Extended Addressing](#20-raw-vs-extended-addressing)
21. [Rich-Storable Reads Freeze at the Boundary](#21-rich-storable-reads-freeze-at-the-boundary)
Appendix A. [Required Spec Changes](#appendix-a-required-spec-changes)

---

## 1. Architecture Overview

The production data flow:

```
Cell.set() → Scheduler → IExtendedStorageTransaction
  → StorageManager.edit() → Transaction reads/writes
  → Transaction.commit()
    → [synchronous] local apply + "commit" notification
    → [async] send to server → server response
      → confirm or revert + notification
      → promise resolves
```

Server side:

```
WebSocket message → parse command → verify signature
  → applyCommit(space.store, clientCommit)
    → server resolves parents from head state
    → seq-based conflict detection
    → write facts + update heads
  → return receipt
  → fan out subscription updates to other clients
```

Key architectural principle: **the client and server share traversal code**
(`packages/runner/src/traverse.ts`). The server imports `SchemaObjectTraverser`
from `@commontools/runner/traverse` via `packages/memory/space-schema.ts`. This
is intentional and must be preserved — it ensures query results are identical on
both sides.

---

## 2. Naming and Interface Changes

Rename to avoid confusion between scheduler notifications and server-to-client
subscriptions:

| Old Name                         | New Name                         | Reason                                                        |
| -------------------------------- | -------------------------------- | ------------------------------------------------------------- |
| `IStorageSubscription`           | `IStorageNotification`           | This is the scheduler's notification sink, not a subscription |
| `IStorageSubscriptionCapability` | `IStorageNotificationCapability` | Same                                                          |

Keep `StorageNotification` (the union type) and `subscribe()` (the method on
`IStorageManager`) unchanged at the public API boundary. More generally, keep
interfaces used outside storage code stable and adapt underneath them.

---

## 3. V1/V2 Coexistence

Both v1 and v2 code paths must exist in parallel during the transition. A
shared code-level default controls which is active, and specific runtimes or
tests may still opt into the non-default path when they are intentionally
exercising it.

### Global Flag

```typescript
// Shared constant — set directly in code, not via env var.
// Browsers don't see environment variables, so this must be a code-level switch.
export const DEFAULT_MEMORY_VERSION: "v1" | "v2" = "v2";
```

**Important:** Do not use environment variables for this flag. The runtime
executes in browsers (Vite-built, eval'd patterns, iframes) where env vars are
not available. The flag must be a code-level constant that is changed by editing
the source.

The current branch state assumes `DEFAULT_MEMORY_VERSION === "v2"`. Explicit
`"v1"` selection should remain only for:

- tests that intentionally exercise v1-only internals
- side-by-side v1/v2 comparison coverage
- temporary debugging when proving a regression is version-specific

### StorageManager

`Runtime` resolves `options.memoryVersion ?? DEFAULT_MEMORY_VERSION` and threads
that resolved value into `StorageManager`, which then creates the appropriate
provider/transaction path:

```typescript
class StorageManager {
  open(space: MemorySpace): IStorageProviderWithReplica {
    if (this.memoryVersion === "v2") {
      return V2Provider.connect({ ... });
    }
    return V1Provider.connect({ ... });
  }

  edit(): IStorageTransaction {
    if (this.memoryVersion === "v2") {
      return V2Transaction.create(this);
    }
    return Transaction.create(this);
  }
}
```

The cutover should happen at high-level storage interfaces such as
`IExtendedStorageTransaction` and `IStorageProvider`. Keep those public-facing
contracts stable while swapping the implementation underneath them.

In particular, if existing public interfaces still expose classification / label
fields, keep them for compatibility in phase 1 but treat them as ignored inputs
until the redesigned metadata model lands.

### Test Selection

Tests may explicitly pin the non-default version, but only when that choice is
semantically important:

```typescript
new Runtime({
  memoryVersion: "v1",
  ...
});

StorageManager.emulate({
  as: signer,
  memoryVersion: "v1",
});
```

Most tests should continue to inherit the shared default so that a default flip
surfaces the real failure set. Explicit pinning is appropriate for tests that
probe v1-only internals such as replica heap shape or v1-specific harness
helpers.

### Server Endpoint

The server uses the same `/api/storage/memory` endpoint. Protocol version is
negotiated on WebSocket connect (e.g., a version field in the first message).
The server MUST reject connections that don't match its expected version — never
silently fall back.

### V1 Code Path Guard

Add a runtime guard to v1 code paths that fires when the v2 flag is active:

```typescript
function assertV1Active(context: string): void {
  if (this.memoryVersion === "v2") {
    throw new Error(
      `v1 code path reached with v2 flag active: ${context}. ` +
        `This indicates v2 wiring is incomplete.`,
    );
  }
}
```

Place this at the entry points of v1's Provider, Transaction, and Consumer
classes. This catches wiring mistakes where v2 code accidentally falls through
to v1.

---

## 4. IExtendedStorageTransaction.commit() Contract

`commit()` has a **two-phase** contract:

### Phase 1: Synchronous Local Apply (before `commit()` returns)

When `commit()` is called, the following happen synchronously — in the same call
stack, before `commit()` returns a promise:

1. Validate reads against local state (pending > confirmed)
2. Build operations from the transaction's writes
3. Apply optimistically to the local replica (pending tier)
4. Fire `"commit"` notification via `IStorageNotification.next()`
5. Queue the command for server transmission

### Phase 2: Async Server Resolution (when the promise resolves)

The promise returned by `commit()` resolves when the server responds:

- **Success**: Promote pending to confirmed. The commit callback fires. Promise
  resolves with `{ ok: unit }`. No additional notification — the `"commit"`
  notification already informed the scheduler.

- **Rejection**: Roll back pending state. Fire `"revert"` notification for any
  entities/paths whose **visible local state** changes when the rejected pending
  entries are removed. If a later pending local state still shadows the same
  entity/path, there is nothing to notify for that path. The commit callback
  fires. Promise resolves with `{ error: ... }`.

The `"revert"` notification MUST fire before the promise resolves, so that by
the time the caller's `await` resumes, storage already reflects the server's
authoritative state. This enables immediate retry without additional
round-trips.

### Commit Callbacks

`addCommitCallback(callback)` registers a callback that fires when the server
confirms or rejects the commit — i.e., at promise resolution time. This is NOT
the same as the `"commit"` notification (which fires at local-apply time).

```typescript
interface IExtendedStorageTransaction extends IStorageTransaction {
  addCommitCallback(cb: (tx: IExtendedStorageTransaction) => void): void;
  // ... convenience methods (readOrThrow, writeOrThrow, etc.)
}
```

---

## 5. Notification Model

Four notification types, with clear timing guarantees:

| Type                | When                               | Timing                                      | Purpose                               |
| ------------------- | ---------------------------------- | ------------------------------------------- | ------------------------------------- |
| `"commit"`          | Local optimistic apply             | **Synchronous** (before `commit()` returns) | Scheduler sees new values immediately |
| `"revert"`          | Server rejects commit              | **Synchronous** (before promise resolves)   | Scheduler sees rollback before retry  |
| `"integrate"`       | Server pushes other-client changes | **Microtask** (acceptable, even desirable)  | Scheduler sees remote updates         |
| `"load"` / `"pull"` | Initial data load                  | After sync completes                        | Scheduler sees initial state          |

### Interaction Between Notifications

**The common case** (successful commit):

```
commit() called → "commit" fires → promise resolves with ok
```

No further notification. One event, one outcome.

**Server rejects our commit:**

```
commit() called → "commit" fires → ... → "revert" fires → promise resolves with error
```

**Other client writes to entity we also wrote (our commit pending):**

```
commit() called → "commit" fires → server subscription delivers other-client's write
  → NO "integrate" yet (local pending state is still the visible state)
  → our commit promise resolves with conflict error
  → "revert" fires if removing the rejected pending write changes visible state
```

The key rule: external changes may be merged into a shadow confirmed/heap tier,
but `"integrate"` only fires when they become the **visible** current state.
While a more advanced local pending state is still visible for an entity/path,
the scheduler must not be notified about the external change. This matches the
current v1 nursery/heap behavior in `packages/runner/src/storage/cache.ts`
(`updateLocalFacts()` + nursery-first reads).

### Ordering Guarantee

When multiple pending commits are in-flight, notifications for a given entity
must reflect the correct causal order. If commits C1, C2, C3 are pending and the
server confirms C1 and C3 but we haven't heard about C2 yet, do NOT notify about
C3's confirmation until C2 is resolved. This prevents the scheduler from seeing
out-of-order state.

### Server Subscription Flush Ordering

The server-side counterpart to the `"revert"` guarantee is:

- Successful commits may be coalesced before subscription delivery, but the
  server must drain the currently pending successful commits for that
  space/branch before it re-runs subscription queries.
- `graph.query` subscription refreshes must reuse the shared traversal code
  path (`packages/runner/src/traverse.ts`), not a second implementation with
  slightly different reachability semantics.
- If a transaction then fails with `ConflictError` while such a refresh is
  pending, the server must flush that subscription refresh before returning the
  conflict response.

That last rule is load-bearing. The client retries immediately after a local
`"revert"`, so by the time the revert promise resolves, the subscribed state
must already reflect the winning remote commit(s).

---

## 6. Pending State and Pipelining

### Two-Tier State

Every entity has two tiers:

- **Confirmed**: Server-acknowledged value + version (seq number)
- **Pending**: Optimistic local writes, not yet confirmed

Reads return pending first, then confirmed. This is load-bearing for pipelining.

### Pipelining (Stacked Commits)

The client can stack multiple commits before the server responds:

```
C1: write A=1 (pending)
C2: read A (sees 1 from C1's pending), write B=A+1 (pending)
Server confirms C1
Server confirms C2
```

### Pending Read Tracking

Pending reads use **local commit indices** (not hashes):

```typescript
interface PendingRead {
  id: EntityId;
  path: readonly string[]; // Relative to EntityDocument.value; [] = root
  localSeq: number; // Client-side commit sequence number
}
```

The client assigns a monotonically increasing `localSeq` to each pending commit.
When building a new commit, if a read came from a pending write, the read
references that commit's `localSeq`.

The server annotates the stored commit with a mapping from `localSeq` to the
final `{ hash, seq }` assigned to that commit. This annotation is separate from
the signed payload (so signatures remain valid).

Server validation of pending reads is simple: look up whether the commit at
`localSeq` N succeeded. If yes, the pending read is valid. If that commit was
rejected, all dependent commits are also rejected.

### Do We Still Need the Global Version Counter?

**Yes.** The per-space global version counter (`seq`) is still needed for:

1. **Confirmed read validation**: `read.seq` anchors a scan for later
   overlapping writes on the same entity/path
2. **Subscription cursors**: "give me changes since seq N"
3. **Point-in-time queries**: "entity state at seq N"
4. **Cross-branch ordering**

But pending state tracking uses `localSeq` instead of hashes.

### Nursery Eviction

When the server confirms a commit, move the entity from pending to confirmed.
When the server rejects a commit, discard the pending value and revert to
confirmed (or to the next-oldest pending value if multiple commits are stacked).

The v1 code has a `deepEqual` check during eviction (keep nursery value if it
differs from server value). With the explicit pending/confirmed model, this
simplifies: just track which `localSeq` each pending value belongs to, and on
confirm/reject, update accordingly.

### Resumable Sessions First, Server Resume Later

Build reconnect support in two stages:

1. **Phase 1 baseline**: The server issues a logical `sessionId` per space. On
   reconnect, the client resumes that session, sends its highest integrated
   `seq`, replays retained commits, and resends active subscriptions.
2. **Phase 2 optimization**: The server may keep recent subscription state for a
   short reconnect window and support a lighter-weight resume path.

The first stage is enough for correctness and crash/reconnect resilience. It is
also easier to reason about because the client remains the source of truth for
which subscriptions should exist.

---

## 7. Confirmed Reads: Path-Aware, Branch-Scoped, and Version-Based

**Spec change**: Drop the `hash` field from `ConfirmedRead`:

```typescript
// Before (spec as written):
interface ConfirmedRead {
  id: EntityId;
  hash: Reference; // ← remove
  version: number;
}

// After:
interface ConfirmedRead {
  id: EntityId;
  branch?: BranchId; // Defaults to commit.branch; merge proposals set this when needed
  path: readonly string[]; // Relative to EntityDocument.value; [] = root
  seq: number; // Per-space global version counter
}
```

The server validates confirmed reads by looking for later writes whose
footprints overlap `(id, path)` after `read.seq` on `read.branch ??
commit.branch`. It never checks the hash.
Dropping it simplifies the client (no need to track fact hashes in confirmed
state) and avoids the `undefined`-in-hash class of bugs entirely.

### Writing to New Entities

When writing to an entity the client has never seen:

```typescript
// "I believe this entity doesn't exist"
reads.confirmed.push({ id: entityId, path: [], seq: 0 });
```

This is a case-by-case choice. Some operations (like `Cell.set()` which always
reads first via `diffAndUpdate()`) will naturally produce a read. Blind writes
that don't need conflict detection can omit the read.

### Compact Redundant Read Dependencies Before Sending A Commit

Clients should compact `reads.confirmed` and `reads.pending` before sending a
commit.

If a recursive read already covers a descendant path for the same entity and
the same dependency version, the descendant read is redundant and should be
omitted from the wire payload.

Examples:

```typescript
// Keep just the root read; the child reads are redundant.
[
  { id, path: [], seq: 17 },
  { id, path: ["profile"], seq: 17 },
  { id, path: ["profile", "name"], seq: 17 },
]
// becomes:
[{ id, path: [], seq: 17 }]
```

```typescript
// Same rule for pending reads.
[
  { id, path: [], localSeq: 4 },
  { id, path: ["profile", "name"], localSeq: 4 },
]
// becomes:
[{ id, path: [], localSeq: 4 }]
```

This compaction must only happen when the ancestor read is recursive and the
dependency version matches:

- `ConfirmedRead`: same `id`, same `branch` resolution, same `seq`
- `PendingRead`: same `id`, same `localSeq`

Do **not** compact a descendant under a `nonRecursive` ancestor read. Those
represent different dependency scopes and must stay distinct.

---

## 8. Server-Side Parent Resolution

**Spec change**: The `parent` field is resolved exclusively by the server.

Operations in `ClientCommit` use `UserOperation` (no `parent` field):

```typescript
interface SetOperation {
  op: "set";
  id: EntityId;
  value: JSONValue;
  // No parent — server resolves from head state
}

interface PatchOperation {
  op: "patch";
  id: EntityId;
  patches: PatchOp[];
  // No parent
}

interface DeleteOperation {
  op: "delete";
  id: EntityId;
  // No parent
}
```

The server resolves `parent` from the current head state when applying the
commit. This eliminates a class of bugs (wrong parent hash, stale parent) and
removes the need for `resolveOperations()` on the client side.

**The server is the ONLY place that resolves parents.** Do not duplicate this
logic on the client. If parent resolution exists in both client and server code,
the implementations will inevitably diverge and cause subtle bugs.

---

## 9. Schema-Driven Queries and traverse.ts

### `graph.query` Is Required, Not Exclusive

`graph.query` with `SchemaPathSelector` is required for cell sync and
schema-driven traversal. It is not the only query mechanism.

`packages/runner/src/traverse.ts` contains `SchemaObjectTraverser` and
`BaseObjectTraverser`. The server imports these via
`packages/memory/space-schema.ts`:

```typescript
import { SchemaObjectTraverser } from "@commontools/runner/traverse";
```

**This shared code is load-bearing.** It ensures that:

- Query results are identical on client and server
- Schema-driven graph traversal follows the same link resolution rules
- Cell links, write redirects, and cycle detection work the same everywhere
- Result documents bring along their recursive `source` lineage the same way
  `loadSource()` does on the client/query side

`syncCell()` depends on the schema-query path to load cells and follow
schema-defined references. Every integration test exercises that path.

That last point matters for piece and process flows: if a queried document has a
top-level `source` sibling, the server must load `of:<short-id>` in the same
space, include it in the result/tracker, and continue following `source` on the
loaded document until the chain ends or a cycle is detected. Do not treat this
as a best-effort extra fetch; it is part of the required traversal semantics.

At the same time, the protocol should still support:

- one-shot `query` for tests, compatibility, and one-time sync
- `query.subscribe` for simple subscriptions
- internal commit-log streaming without reintroducing a public type axis

The public v2 data model assumes JSON entities only. Do not preserve v1's
typed-data model just to carry the commit log forward as another pseudo-entity.

### `schema: false` Means "Matches Nothing"

In JSON Schema, `false` means "no value matches this schema" — like `never` in
TypeScript. This is NOT "no schema" or "untyped."

When traverse.ts encounters a cell whose schema resolves to `false`, it **stops
following references** from that cell. This is the schema-driven termination
condition for graph traversal — it prevents infinite expansion when a reference
points to data whose shape the query doesn't care about.

Key code locations:

- `cfc.ts:789` — schema resolution can produce `false`
- `traverse.ts:1116` — traverser checks for `false` schema
- `cache.ts:741` — cache handles `schema: false` entities

### graph.query Must Be in Phase 1

`graph.query` (schema-driven traversal) is not optional. It is how `syncCell()`
loads cells and follows schema-defined references. Integration tests exercise
`syncCell()`. Therefore `graph.query` must be implemented before integration
tests can pass.

---

## 10. Wire Format and Signing

### Keep UCANTO with Batch Signing

The existing UCANTO invocation format supports batch signing natively. The
`Access.authorize()` function already accepts an array of invocation references
and produces a single signature covering all of them:

```typescript
// From packages/memory/access.ts
const authorize = async (access: Reference[], as: Signer) => {
  const proof = {};
  for (const invocation of access) {
    proof[invocation.toString()] = {};
  }
  const { ok: signature } = await as.sign(refer(proof).bytes);
  return { ok: { signature, access: proof } };
};
```

### Batch Format

Multiple transactions can be batched into a single signed message:

```typescript
// Client sends:
{
  invocations: [
    { iss: userDID, sub: spaceDID, cmd: "/memory/transact", args: { ... } },
    { iss: userDID, sub: spaceDID, cmd: "/memory/transact", args: { ... } },
  ],
  authorization: {
    signature: singleSignatureOverAllInvocations,
    access: { "<ref1>": {}, "<ref2>": {} }
  }
}

// Server responds with per-invocation results (order may differ):
{
  receipts: [
    { invocation: "<ref1>", ok: { commit: ... } },
    { invocation: "<ref2>", error: { conflict: ... } },
  ]
}
```

Each invocation succeeds or fails independently. Invocation 1 succeeding does
not depend on invocation 2. Batching optimizes signatures, not atomicity.

### Persist Invocation/Auth Separately from Commit Identity

For every successful **write-class** command (`/memory/transact`,
`/memory/branch/create`, `/memory/branch/delete`), persist three linked
artifacts:

1. canonical write payload
2. canonical UCAN invocation object
3. verified authorization object

Recommended normalization:

```typescript
type BranchLifecycleWrite =
  | { cmd: "/memory/branch/create"; args: { localSeq: number; name: string; fromBranch?: string; atSeq?: number } }
  | { cmd: "/memory/branch/delete"; args: { localSeq: number; name: string } };

type CommitRow = {
  hash: Reference;             // refer(canonical write payload)
  invocationRef: Reference;    // refer(invocation)
  authorizationRef: Reference; // refer(authorization)
  original: ClientCommit | BranchLifecycleWrite;
  // ...
};
```

This split matters for two reasons:

- **Stable semantic identity:** the same logical write may be replayed inside a
  fresh invocation or fresh authorization wrapper. `commit.hash` must remain
  the hash of the semantic payload, not of the transport envelope.
- **Batch sharing:** one authorization may cover many invocation refs. Storing
  authorization separately avoids duplicating signatures and makes batch
  semantics explicit.

Persisting invocation/auth gives phase-1 v2 a durable record of:

- **who** submitted the command (`invocation.iss`)
- **where** it targeted (`invocation.sub`)
- **what** code bundle was declared (`clientCommit.codeCID`, if present, for
  `/memory/transact`)

It does **not** by itself attest to a distinct provider/executor identity or to
post-execution policy enforcement. Those belong in a later receipt/attestation
layer.

Keep the commit hash even though runtime semantics move to `seq`:

- **Commit hash** identifies the canonical write payload and is the stable
  dedupe key for replay.
- **`seq`** is the server's canonical ordering and the only identifier the read
  path, subscription path, and PIT logic should depend on.

If a later verifiable-computation design needs richer receipts (input
commitments, policy commitments, TEE bindings), add a separate receipt table or
artifact keyed by its own content hash. Do not redefine `commit.hash` to mean
"signed envelope" or "execution receipt."

### Queries Can Also Be Batched

Any command type can be included in a batch. However, the primary use case is
batching transactions (which benefit most from reduced signing overhead).

### Server Signature Verification

The server MUST verify signatures before applying any commands. Unsigned or
incorrectly signed invocations MUST be rejected.

### Use `merkle-reference/json` Everywhere

Always import from `merkle-reference/json`, never from `merkle-reference`
directly:

```typescript
import { refer } from "merkle-reference/json";
```

The `/json` subpath handles `undefined` gracefully (strips the property,
matching `JSON.stringify()` semantics). This eliminates an entire class of
"Unknown type undefined" bugs.

If you need a caching wrapper (like the existing `reference.ts`), modify that
wrapper to use `merkle-reference/json` internally.

---

## 11. ACL and Space Initialization

### ACL Entity

The ACL is stored as a regular entity within the space:

- **Entity ID**: The space DID itself (e.g., `did:key:z6Mk...`)
- **Type**: `application/json`
- **Value**: A map of DID or `"*"` to capability level

```typescript
type ACL = {
  [user: DID | "*"]?: "READ" | "WRITE" | "OWNER";
};
```

Capability hierarchy: `READ < WRITE < OWNER`.

Command requirements:

- `/memory/transact`, `/memory/branch/create`, `/memory/branch/merge`, and `/memory/branch/delete` require `WRITE`
- `/memory/session/open`, `/memory/query/subscribe`, `/memory/graph/query`, `/memory/query` (compatibility-only), and `/memory/branch/list` require `READ`
- ACL modifications require `OWNER`

### Space Initialization (Bootstrap Transaction)

A new space requires a bootstrap transaction to set the ACL. This transaction is
signed with the **space keypair** (not the user keypair):

```typescript
{
  iss: spaceDID,          // Space signs its own bootstrap
  sub: spaceDID,
  cmd: "/memory/transact",
  args: {
    reads: { confirmed: [{ id: spaceDID, path: [], seq: 0 }], pending: [] },
    operations: [{
      op: "set",
      id: spaceDID,        // Entity ID = space DID
      value: {
        value: {
          [userDID]: "OWNER",
          "*": "READ",
        }
      }
    }],
  }
}
```

The server grants access when `iss === sub` (space owner identity), so this
bootstrap transaction is always authorized.

### Bootstrap Cannot Be Batched

The ACL bootstrap transaction uses the space keypair as signer, while all
subsequent transactions use the user keypair. Since batch signing produces a
single signature from a single signer, the bootstrap transaction MUST be sent
separately.

### ACL Is Part of the Protocol Spec

The ACL schema, capability hierarchy, command requirements, and bootstrap flow
should be formally defined in section 04 of the spec (Protocol).

---

## 12. Emulation Mode

### Principle: Exercise Real Server Code

The emulation mode (used in unit tests) must exercise as much of the actual
server code as possible. Only the transport layer should be mocked — all other
components (provider, memory service, space, commit logic) must be real code.
Duplicating server logic in the mock transport causes bugs that only appear in
production.

### Correct Architecture

```
Test → StorageManager.emulate({ as: signer })
  → provider (real client code)
    → mock transport (replaces WebSocket)
      → memory service (real server code)
        → Space with in-memory SQLite
      ← real server responses
    ← mock transport delivers responses
  → provider processes responses (real client code)
```

The mock transport is the ONLY mock. It replaces the network layer with
synchronous or microtask-based message passing. Everything else — the provider,
the memory service, the space, the commit logic — is real code.

### In-Memory SQLite

Use `data:,memory` or equivalent in-memory URL for the SQLite database. Each
space gets its own in-memory database (matching production behavior).

### External Commit Injection

For testing multi-client scenarios, provide a test utility that can inject
commits as if from another client:

```typescript
interface TestTransport {
  injectExternalCommit(
    entities: Array<{ id: EntityId; value: JSONValue }>,
  ): void;
}
```

This calls the real memory service's `transact()` with a different "client"
identity and triggers subscription updates to the test client.

---

## 13. Patch Operations

### Our Own Operation Types

We define our own patch operations inspired by JSON Patch (RFC 6902) but not
bound by it. Key differences from RFC 6902:

- **`add` creates intermediate parents automatically**. Writing to
  `/person/name` creates the `person` object if it doesn't exist. Numeric path
  segments create arrays; string segments create objects. Eventually, when a
  schema is available, it guides the choice.
- **Custom `splice` operation** for efficient array manipulation.
- **Future CRDT/OT operations** for collaborative text editing.

```typescript
type PatchOp =
  | { op: "replace"; path: JSONPointer; value: JSONValue }
  | { op: "add"; path: JSONPointer; value: JSONValue } // Creates intermediate parents
  | { op: "remove"; path: JSONPointer }
  | { op: "move"; from: JSONPointer; path: JSONPointer }
  | {
    op: "splice";
    path: JSONPointer;
    index: number;
    remove: number;
    add: JSONValue[];
  };
// Future:
// | { op: "text-insert"; path: JSONPointer; offset: number; text: string }
// | { op: "text-delete"; path: JSONPointer; offset: number; length: number }
```

### Patches are applied in order, left to right

Each operation transforms the state produced by the previous one. Invalid
operations fail the entire patch atomically.

### Phasing

Initially, `Cell.set()` continues to use `diffAndUpdate()` which often produces
full `set` operations (replacing the entire entity value). This creates
path-aware read dependencies because `diffAndUpdate()` reads the current value
to compute diffs.

The current branch now has a conservative direct-patch fast path for the
v2-native commit draft hook:

- Stable object-path writes can emit `patch` operations directly.
- Today that includes `replace`, `add`, and `remove` on non-array JSON paths.
- Array-index writes still fall back to full `set`.
- Overlapping writes within the same transaction still fall back to full `set`.

This means `Cell.set()` and path writes no longer always have to materialize a
whole-document `set` when the transaction core can prove the write is a simple,
position-independent object-path update.

Later phases will widen this safely: `Cell.push()` / `Cell.remove()` can
produce more targeted operations, and some patch classes may eventually shed
unnecessary read dependencies. But not all patches are equal:

- **Position-independent patches** overwrite stable keys and are candidates for
  future read-free fast paths.
- **State-dependent patches** depend on the current shape or ordering of the
  document. `splice`, positional array edits, and today's `remove` behavior are
  in this class and should retain read dependencies until we add stronger
  semantics.

### Native Commit Drafts May Carry Local-Only Materialized Values

The v2 runner path uses a native commit-draft hook between the transaction core
and the local replica. For `patch` operations, that draft may include both:

- the wire-visible patch list (`patches`)
- the materialized post-patch document value used for optimistic local apply

This is a local optimization boundary only. The final wire commit still sends
just `{ op: "patch", id, patches }`. Do not treat the materialized value as a
protocol field.

### Concurrent Patches Without Overlapping Reads

Two patches to the same entity without overlapping read dependencies are treated as
last-writer-wins (LWW) **only when they are genuinely blind overwrites**:

```
Client A: replace /name = "Alice" (no overlapping reads)
Client B: replace /age = 30 (no overlapping reads)
→ Both succeed. Patches apply sequentially on the server.
```

Do not generalize this to state-dependent operations like `splice` or today's
`remove` behavior. Those depend on the current document shape and should keep
read dependencies until we introduce position-independent variants.

---

## 14. Randomized V1/V2 Parallel Test

### Purpose

A single test that runs the same random operations against both v1 and v2
providers and compares the behavior visible at the cutover interfaces
(`IExtendedStorageTransaction`, `IStorageProvider`, scheduler notifications).
The goal is equivalent observable behavior at that boundary, not identical
internal transport or commit-log machinery.

### Design

```typescript
type LogEntry =
  | { op: "write"; entity: string; value: unknown; result: "ok" | "error" }
  | { op: "read"; entity: string; value: unknown }
  | { op: "commit"; txId: number; result: "ok" | "conflict"; detail?: string }
  | {
    op: "notify";
    type: "commit" | "revert" | "integrate";
    entities: string[];
    values: Record<string, unknown>;
  }
  | { op: "subscribe"; entity: string }
  | { op: "subscription-update"; entity: string; value: unknown };
```

### Requirements

- **Deterministic**: Use a seeded PRNG so failures are reproducible. Log the
  seed at test start.
- **Hundreds of operations**: ~200-500 operations per run covering writes,
  reads, commits, multi-entity transactions, and subscriptions.
- **Notification ordering included**: The log captures notification type,
  affected entities, AND their values. This catches async-vs-sync timing
  differences.
- **Full entity values in notifications**: Include values, not just entity IDs,
  to catch value-level discrepancies.
- **Multi-client (P2)**: Initially single-client. Once that passes, add a second
  client writing to the same space via `injectExternalCommit()` and verify both
  clients' logs converge.
- **No real server**: Uses emulation mode with in-memory DB.
- **Server subscription path**: Test that client A's writes trigger subscription
  updates on client B (via the shared memory service in emulation).

### Execution

```typescript
for (const version of ["v1", "v2"]) {
  const log: LogEntry[] = [];
  const manager = StorageManager.emulate({ as: signer, version });
  // ... run random operations, log everything ...
  logs[version] = log;
}
assertObservableEquivalence(logs.v1, logs.v2);
```

---

## 15. Integration Testing

### Running Integration Tests

The repo has a centralized integration test runner at the root:

```bash
# Run ALL integration tests (starts servers automatically)
deno task integration

# Run tests for a specific package
deno task integration <package>

# Run tests matching a filter within a package
deno task integration <package> <filter>
```

This runs `tasks/integration.ts`, which:

1. Starts local dev servers (toolshed + shell) with a random port offset
2. Runs integration tests for each package sequentially
3. Stops servers when done (unless `PORT_OFFSET` was set explicitly)

### Packages with Integration Tests

The following packages have integration tests:

| Package | Server needed | Notes |
|---------|:---:|-------|
| `runner` | Yes | Core storage round-trip, `syncCell()`, schema traversal |
| `runtime-client` | Yes | Client runtime tests |
| `shell` | Yes | End-to-end smoke test (browser, headless) |
| `background-charm-service` | Yes | Background service tests (browser, headless) |
| `patterns` | Yes | Pattern execution tests (browser, headless) |
| `cli` | Yes | CLI command tests (uses shell script) |
| `generated-patterns` | No | Standalone pattern generation tests |

### Recommended Test Order for v2 Validation

1. **`shell`** — Run first as an end-to-end smoke test. If shell works, the
   core stack is functional.
2. **`runner`** — Core storage tests: persistence, schema queries, nursery.
3. **`patterns`** — Pattern execution exercises the full stack.
4. **`cli`** — CLI commands exercise the API surface.

### Requirements

- **Must use a real toolshed server** (not emulation). Tests that use emulation
  are regular unit tests, not integration tests.
- **Must pass with MEMORY_VERSION=v2**. This is the success criterion for
  Phase 1.
- **Must verify no v1 code is running**: The v1 code path guard (from
  [section 3](#3-v1v2-coexistence)) will throw if any v1 code is reached.

### Existing Integration Tests

The existing integration tests already test `syncCell()`, schema traversal,
and multi-entity scenarios across multiple packages. Getting them all to pass
with `MEMORY_VERSION=v2` is the success criterion for Phase 1.

---

## 16. Phasing

### Phase 1: Core v2 Stack (must pass integration tests)

1. `IStorageProvider` v2 implementation
2. `IExtendedStorageTransaction` with synchronous local commit + async server
3. `IStorageNotification` (renamed from IStorageSubscription)
4. Server handlers (same endpoint, version negotiation)
5. Emulation mode with real server code + in-memory DB
6. Schema-driven queries via `graph.query` using shared `traverse.ts`
7. Server-side parent resolution
8. Confirmed reads with `seq` only (no hashes)
9. Pending reads with `localSeq`
10. ACL + space initialization
11. Batch signing via UCANTO
12. `merkle-reference/json` everywhere
13. Public storage APIs stable at the cutover boundary
14. Resumable logical sessions with client-driven replay/resubscribe
15. V1 code path guards
16. Randomized v1/v2 parallel test
17. All existing integration tests passing with `MEMORY_VERSION=v2`

### Phase 2: Optimization

1. JSON Patch optimization (Cell.set → patch operations)
2. Position-independent remove/update forms
3. Claim-free fast paths only for position-independent patch classes
4. Short-lived server-side subscription resume cache

### Phase 3: Advanced Features

1. Branching wired up end-to-end
2. GC scheduling
3. CRDT/OT operations for text
4. Classification/redaction with the redesigned metadata model

### Order of Implementation Within Phase 1

Suggested order (server first, then client, then tests):

1. **Server handlers** — Memory service, WebSocket protocol handlers, route registration (plus blob HTTP routes).
   These are self-contained and testable independently.
2. **Emulation mode** — Mock transport backed by real memory service. This
   enables all subsequent client-side testing.
3. **Provider** — IStorageProvider implementation with confirmed/pending state,
   notification firing, and pipelining.
4. **Transaction adapter** — IExtendedStorageTransaction implementation bridging
   the scheduler's transaction layer to the provider.
5. **StorageManager wiring** — Open/edit dispatch based on global flag.
6. **ACL bootstrap** — Space initialization transaction.
7. **Parallel test** — Randomized v1/v2 comparison.
8. **Integration tests** — Fix any remaining issues until all pass.

---

## 17. Gotchas

### `cell.set()` Is Not a Blind Write

`cell.set(value)` calls `diffAndUpdate()`, which reads the current value to
compute a diff. This read creates a path-aware read dependency in the
transaction's history. Consequence: parallel `cell.set()` calls to the same
entity often produce conflict detection, especially when they touch overlapping
paths.

This is the correct behavior during Phase 1. In Phase 2, when `Cell.set()`
produces patch operations directly, the implicit whole-entity read can narrow to
the actual touched paths.

### Double-Notification Prevention

In-process transports (used in emulation mode) deliver responses via
`queueMicrotask()`. This means subscription updates for your OWN commits arrive
BEFORE the commit response. Without filtering, entities get notified twice —
once from the subscription update and once from the commit response.

Prevention strategy:

1. In the subscription update handler, suppress notifications for entities/paths
   whose visible state is still provided by pending local writes. It is fine to
   merge the server revision into a shadow confirmed/heap tier.
2. In the commit response handler, compute notifications from the resulting
   **visible** state transition after removing the resolved/rejected pending
   entries. If a later pending value is still current, do not emit a notification
   for that entity/path.

### Self-Referential Thenable OOM

`Promise.resolve(obj)` where `obj` has a `.then()` method causes V8 to call
`obj.then()` recursively, leading to infinite recursion and OOM. If any object
in the v2 response chain has a `.then()` method (e.g., a Proxy), do NOT pass it
to `Promise.resolve()`. Use `Promise.resolve().then(() => obj)` or a plain
callback instead.

### `queueMicrotask` Ordering in Tests

In-process transports (used in emulation mode) may deliver responses via
`queueMicrotask()`. This means subscription updates can arrive before commit
responses in the same event loop iteration. Design the provider to handle either
ordering — do not assume commit response arrives before subscription updates.

### Test File Naming Convention

- Runner tests: `.test.ts` suffix
- Memory tests: `-test.ts` suffix

---

## 18. Anti-Patterns

### Do NOT Duplicate Server Logic on the Client

Parent resolution belongs on the server only. The client sends `UserOperation`
without `parent`. If parent resolution logic exists in both the client transport
and the server memory service, the implementations will diverge and cause subtle
bugs.

### Do NOT Use Hash Comparison for Pending State Routing

With seq-based confirmed reads and `localSeq`-based pending reads, routing is
trivial:

```
If entity value came from pending state → reads.pending with { path, localSeq }
If entity value came from confirmed state → reads.confirmed with { path, seq }
If entity has no local state → reads.confirmed with { path, seq: 0 }
```

No hash comparison needed. A complex hash comparison algorithm for this routing
is unnecessary complexity.

### Do NOT Add Speculative Bulk-Write Hooks Without Measurement

`Cell.set()` performance is not dominated by every abstraction layer equally.
Before adding a new bulk write path or bypass around
`IExtendedStorageTransaction.writeValueOrThrow()`, measure the real hotspot.

In practice, the largest remaining v2 costs have clustered around:

- `normalizeAndDiff()` and other `Cell.set()` preprocessing
- repeated transaction-local object updates
- scheduler/query invalidation work

A naive "bulk apply the change set directly to the raw transaction" hook may add
surface area without materially improving the dominant benchmarks. Only keep a
new fast path if the benchmark delta is clear enough to justify the extra API.

One concrete safe intermediate step is a **native batched path-write hook**
behind `IExtendedStorageTransaction`, while leaving `applyChangeSet()` on the
existing one-write-at-a-time path until unschematized proxy reads prove they
observe the same in-transaction state. The hook itself can simplify v2-native
parent materialization and future patch emission work, but flipping higher-level
call sites over to it should remain benchmark- and parity-driven.

---

## 19. Minimal Transaction Compatibility Surface

The v2 runner does **not** need a full v1-style `Journal` / `Chronicle`
reconstruction internally.

What the current runtime actually consumes from a completed transaction is much
smaller:

1. A scheduler-facing **reactivity log**
2. A commit/conflict-facing stream of **read activities**
3. A debug/summary-facing stream of **write details**

That means the preferred native v2 transaction surface is:

```typescript
interface IStorageTransaction {
  getReactivityLog?(): TransactionReactivityLog;
  getReadActivities?(): Iterable<IReadActivity>;
  getWriteDetails?(space: MemorySpace): Iterable<TransactionWriteDetail>;
  getNativeCommit?(space: MemorySpace): NativeStorageCommit | undefined;
  writeBatch?(writes: Iterable<ITransactionWriteRequest>): Result<Unit, WriterError | WriteError>;
}
```

`journal.activity()`, `journal.novelty(space)`, and `journal.history(space)`
should remain only as compatibility fallbacks for legacy code and tests. They
must not dictate the internal structure of the v2 transaction core.

Implementation guidance:

- `txToReactivityLog()` should probe `getReactivityLog()` first.
- Conflict tracking should probe `getReadActivities()` first.
- Human-facing transaction summaries/debug views should probe
  `getWriteDetails(space)` first.
- Compatibility wrappers such as `ExtendedStorageTransaction` and
  `TransactionWrapper` should forward these narrow hooks instead of forcing
  callers to unwrap `.tx` just to reach the native v2 data.
- Equal-value writes should be dropped at write time, not only filtered later
  during commit building. Otherwise the v2 transaction accumulates dead
  `writeDetails`, dead reactivity-log entries, and avoidable no-op commit work.
- If the replica can consume native v2 operations directly, expose them through
  a narrow `getNativeCommit()` hook and call a replica-side `commitNative()`
  path instead of re-encoding the write set as legacy `{ the, of, is }` facts
  only to decode them again before `ClientCommit` creation.
- If v2 adds a native `writeBatch()` / `writeValuesOrThrow()` pair, treat it as
  scaffolding for later optimization, not proof that every higher-level change
  producer should use it immediately.
- If a future caller needs more detail, add another **narrow** native hook
  instead of recreating broad v1 journal machinery inside v2.

This is the intended direction for simplifying the v2 runner integration: keep
`IExtendedStorageTransaction` stable, but make the internal v2 transaction core
export exactly the native products the runner uses.

### Native Commit Draft Hook

The last major v1-shaped translation layer in the runner is often the commit
payload boundary, not the transaction working copy itself.

Concretely, a clean v2 transaction core may already:

- track reads directly as `IReadActivity`
- track writes directly as per-document working copies
- export a direct scheduler-facing reactivity log

and still lose that simplicity if `commit()` first serializes the result back
into legacy `facts` and `claims`, only for the v2 replica to immediately turn
those same writes back into `Operation[]` for the wire protocol.

Preferred shape:

1. Keep `IExtendedStorageTransaction` unchanged for runner callers.
2. Let the native v2 transaction expose a narrow `getNativeCommit(space)` hook.
3. Let the native v2 replica expose a narrow `commitNative(draft, source)` hook.
4. Keep the old `commit(ITransaction, source)` path only as fallback for v1 and
   any remaining compatibility callers.

This keeps the runtime boundary stable while removing a large amount of
accidental v1 structure from the v2 hot path.

---

## 20. Raw vs Extended Addressing

There are two address layers in runner storage code, and mixing them up causes
subtle bugs:

### Raw `IStorageTransaction`

Raw transaction reads and writes operate on the **stored document envelope**.
For JSON entities that means the top level may contain siblings such as:

```json
{
  "value": { ... },
  "source": { "/": "..." }
}
```

Examples:

- Write the entire stored document: path `[]`, value `{ value: {...} }`
- Read the user-visible payload: path `["value"]`
- Read lineage metadata: path `["source"]`

### `IExtendedStorageTransaction`

The extended wrapper exists to preserve runner-facing convenience methods:

- `readValueOrThrow(address)` prepends `["value"]`
- `writeValueOrThrow(address, value)` prepends `["value"]`
- nested writes create missing parents when needed

This means a raw v2 transaction test is **not** interchangeable with an
extended transaction test.

Important consequences:

- A raw nested write to `["value", ...path]` will fail on a missing document
  unless the caller first creates the document or writes the whole envelope.
- The extended wrapper is the compatibility layer that provides parent
  creation for nested value writes.
- Benchmarks or tests that write plain payloads at raw path `[]` are measuring
  envelope-level storage behavior, not the user-facing `writeValueOrThrow()`
  contract. If you want root-level no-op equality on the main runtime path,
  compare extended writes against extended writes, or compare raw envelopes
  against raw envelopes.
- Scheduler-facing reactivity logs should strip the leading `"value"` segment
  before exposing paths to the rest of the runtime.

When writing v2-native tests, decide explicitly which layer is under test:

- Use raw transactions to test native storage-core behavior.
- Use `IExtendedStorageTransaction` to test the compatibility contract that
  runner code already depends on.

---

## 21. Rich-Storable Reads Freeze at the Boundary

When `richStorableValues` is enabled, the v2 transaction core should preserve
the same caller-visible immutability contract that existing runner code already
observes on the v1 path.

The rule is:

- keep the **internal working copy mutable**
- isolate caller-owned values on write before they enter transaction state
- freeze values only at the **read boundary** exposed to callers

That means a v2 transaction should not deep-freeze its live working copy while a
transaction is still open. Instead it should expose a cached frozen snapshot for
raw reads such as `tx.readValueOrThrow(...)`, `reader.read(...)`, and any other
read API that returns stored values under rich mode.

Why this matters:

1. It preserves the v1-visible invariant that rich-storable reads are immutable.
2. It prevents callers from mutating transaction-local state by changing the
   object returned from a read.
3. It avoids freezing the internal working set that subsequent writes still need
   to update efficiently.
4. It keeps query-result proxy behavior stable, because proxy targets still see
   the same frozen-object semantics that the rest of the runner expects.

Implementation guidance:

- Clone plain arrays / plain records on write before placing them into the
  working copy so later caller mutation cannot backdoor- mutate transaction
  state.
- Freeze the **returned read value**, not the entire current document, so
  nested-path reads do not repeatedly deep-freeze unrelated siblings during
  large `Cell.set()` traversals.
- Freeze the stored payload value that crosses the read boundary, not the
  mutable bookkeeping or working copy that the transaction continues to update.
- Treat this as a read-contract guarantee, not as a requirement that the v2
  transaction core itself be immutable internally.

---

## Appendix A: Required Spec Changes

The following changes to the v2 spec documents (01-06) were needed to align the
spec with architectural decisions made during implementation. Each change is
marked with the spec section it affects.

**Note:** All changes in this appendix have been applied to the spec documents.

### A.1. Make `ConfirmedRead` Path-Aware, Branch-Scoped, and Drop `hash` (03-commit-model.md §3.4)

```typescript
// Before:
interface ConfirmedRead {
  id: EntityId;
  hash: Reference;
  version: number;
}

// After:
interface ConfirmedRead {
  id: EntityId;
  branch?: BranchId;
  path: readonly string[];
  seq: number;
}
```

Rename `version` → `seq` throughout the spec for consistency. Confirmed reads
default to `commit.branch`, but merge proposals can override `branch` per read
when validating source or merge-base observations.

### A.2. Replace `PendingRead` with `localSeq` (03-commit-model.md §3.4)

```typescript
// Before:
interface PendingRead {
  id: EntityId;
  hash: Reference;
  fromCommit: Reference;
}

// After:
interface PendingRead {
  id: EntityId;
  path: readonly string[];
  localSeq: number;
}
```

Add: "The server annotates stored commits with a mapping from `localSeq` to the
resolved `{ hash, seq }` for that commit. This annotation is separate from the
signed payload."

### A.3. Remove `parent` from Operations (03-commit-model.md §3.1)

Operations sent by the client do not include `parent`. The server resolves
parent from the current head state. Update all operation type definitions to
remove the `parent` field. Add a note: "The server resolves `parent` references
from the current head state when applying the commit."

### A.4. Add Batch Invocation Support (04-protocol.md §4.2)

Add a new section describing batch invocations:

- Multiple invocations in a single message
- Single UCANTO authorization covering all invocations
- Per-invocation success/failure (independent)
- Response contains per-invocation receipts

### A.5. Add ACL Specification (04-protocol.md, new §4.6)

Formally define:

- ACL entity structure (`type ACL = { [user: DID | "*"]?: Capability }`)
- Capability hierarchy (`READ < WRITE < OWNER`)
- Command-to-capability mapping
- Space bootstrap flow (space-signed initial transaction)
- Authorization check algorithm (issuer === subject → always allowed)

### A.6. Emphasize Read Precedence (03-commit-model.md §3.3.3)

The spec already says reads check pending first, then confirmed. Add bold
emphasis and a worked example showing why this is critical for pipelining
correctness.

### A.7. Add Notification Ordering Guarantee (03-commit-model.md, new §3.8)

Add a section on notification ordering: "When multiple pending commits are
in-flight, notifications for a given entity must reflect causal order. The
client MUST NOT notify about a later commit's confirmation until all earlier
commits for overlapping entities are resolved."

### A.8. Rename `version` → `seq` Throughout

For consistency with the implementation guidance, rename the version counter
from `version` to `seq` in all spec documents. Update `StoredFact.version`,
`ConfirmedRead.version`, subscription `since` parameters, etc.

### A.9. Update Patch Operations (01-data-model.md §6)

Update the PatchOp section to note:

- Operations are inspired by RFC 6902 but not bound by it
- `add` creates intermediate parents (numeric → array, string → object,
  schema-guided when available)
- Future operations (CRDT/OT for text) are planned
- Remove the phrase "subset of JSON Patch (RFC 6902)"

### A.10. Add Protocol Version Negotiation (04-protocol.md §4.1)

Add: "The client MUST declare its protocol version in the first WebSocket
message. The server MUST reject connections with an unsupported version. The
server MUST NOT silently fall back to an older protocol version."
