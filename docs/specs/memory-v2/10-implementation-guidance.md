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
19. [Appendix A: Required Spec Changes](#appendix-a-required-spec-changes)

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
`IStorageManager` that returns a cancel handle) unchanged.

---

## 3. V1/V2 Coexistence

Both v1 and v2 code paths must exist in parallel during the transition. A global
flag controls which is active.

### Global Flag

```typescript
// Module-level default, overridable by environment variable
const MEMORY_VERSION: "v1" | "v2" =
  (Deno.env.get("MEMORY_VERSION") as "v1" | "v2") ?? "v2";
```

### StorageManager

`StorageManager` reads the global flag and creates the appropriate provider:

```typescript
class StorageManager {
  open(space: MemorySpace): IStorageProviderWithReplica {
    if (MEMORY_VERSION === "v2") {
      return V2Provider.connect({ ... });
    }
    return V1Provider.connect({ ... });
  }

  edit(): IStorageTransaction {
    if (MEMORY_VERSION === "v2") {
      return V2Transaction.create(this);
    }
    return Transaction.create(this);
  }
}
```

### Test Selection

Only `StorageManager.emulate()` accepts a version parameter, and only for tests
that need to compare implementations:

```typescript
static emulate(options: {
  as: Signer;
  version?: "v1" | "v2";  // defaults to global flag
}): StorageManager
```

Individual tests should NOT select a version. The global flag or env variable
controls which version runs. The exception is the parallel comparison test (see
[section 14](#14-randomized-v1v2-parallel-test)).

### Server Endpoint

The server uses the same `/api/storage/memory` endpoint. Protocol version is
negotiated on WebSocket connect (e.g., a version field in the first message).
The server MUST reject connections that don't match its expected version — never
silently fall back.

### V1 Code Path Guard

Add a runtime guard to v1 code paths that fires when the v2 flag is active:

```typescript
function assertV1Active(context: string): void {
  if (MEMORY_VERSION === "v2") {
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
  entities that are STILL in pending state (not already superseded by an
  `"integrate"` notification — see [section 5](#5-notification-model)). The
  commit callback fires. Promise resolves with `{ error: ... }`.

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
  → "integrate" fires (entity now has newer server value)
  → our commit promise resolves with conflict error
  → NO "revert" for entities already updated by "integrate"
```

The key rule: on rejection, `"revert"` only fires for entities that are STILL in
pending state — entities already superseded by `"integrate"` are skipped. This
means `"revert"` can be a partial notification covering a subset of the original
commit's entities.

### Ordering Guarantee

When multiple pending commits are in-flight, notifications for a given entity
must reflect the correct causal order. If commits C1, C2, C3 are pending and the
server confirms C1 and C3 but we haven't heard about C2 yet, do NOT notify about
C3's confirmation until C2 is resolved. This prevents the scheduler from seeing
out-of-order state.

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
  localSeq: number; // Client-side commit sequence number
}
```

The client assigns a monotonically increasing `localSeq` to each pending commit.
When building a new commit, if a read came from a pending write, the read
references that commit's `localSeq`.

The server annotates the stored commit with a mapping from `localSeq` to actual
server-side commit identifiers. This annotation is separate from the signed
payload (so signatures remain valid).

Server validation of pending reads is simple: look up whether the commit at
`localSeq` N succeeded. If yes, the pending read is valid. If that commit was
rejected, all dependent commits are also rejected.

### Do We Still Need the Global Version Counter?

**Yes.** The per-space global version counter (`seq`) is still needed for:

1. **Confirmed read validation**: `read.seq >= server.head.seq`
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

---

## 7. Confirmed Reads: Version-Based Only

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
  seq: number; // Per-space global version counter
}
```

The server validates confirmed reads using `read.seq >= server.head.seq`. It
never checks the hash. Dropping it simplifies the client (no need to track fact
hashes in confirmed state) and avoids the `undefined`-in-hash class of bugs
entirely.

### Writing to New Entities

When writing to an entity the client has never seen:

```typescript
// "I believe this entity doesn't exist"
reads.confirmed.push({ id: entityId, seq: 0 });
```

This is a case-by-case choice. Some operations (like `Cell.set()` which always
reads first via `diffAndUpdate()`) will naturally produce a read. Blind writes
that don't need conflict detection can omit the read.

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

interface ClaimOperation {
  op: "claim";
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

### All Data Queries Use `graph.query`

All production data queries use `graph.query` with `SchemaPathSelector`. This is
the only query mechanism — there is no alternative.

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

`syncCell()` uses `graph.query` to load cells and follow schema-defined
references. Every integration test exercises `syncCell()`.

Wildcard subscriptions (`"*"`) exist only for commit log streaming (server-to-
server replication) and are being deprecated. They are not a data query
mechanism.

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

- `/memory/transact` requires `WRITE`
- `/memory/query`, `/memory/query/subscribe` require `READ`
- All other commands require `OWNER`

### Space Initialization (Bootstrap Transaction)

A new space requires a bootstrap transaction to set the ACL. This transaction is
signed with the **space keypair** (not the user keypair):

```typescript
{
  iss: spaceDID,          // Space signs its own bootstrap
  sub: spaceDID,
  cmd: "/memory/transact",
  args: {
    reads: { confirmed: [{ id: spaceDID, seq: 0 }], pending: [] },
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

Initially, `Cell.set()` continues to use `diffAndUpdate()` which produces full
`set` operations (replacing the entire entity value). This creates claims (read
dependencies) because `diffAndUpdate()` reads the current value to compute
diffs.

Later phases will optimize: `Cell.set()` can directly produce `patch`
operations, and eventually `Cell.push()` / `Cell.remove()` can produce targeted
`splice` operations. Once patches are used directly, the implicit claim from
`diffAndUpdate()` goes away — only explicit claims remain.

### Concurrent Patches Without Claims

Two patches to the same entity without read claims are treated as
last-writer-wins (LWW). They can both succeed if they only write and don't read:

```
Client A: patch /name = "Alice" (no claims)
Client B: patch /age = 30 (no claims)
→ Both succeed. Patches apply sequentially on the server.
```

Patches only conflict if there are read claims with stale versions.

---

## 14. Randomized V1/V2 Parallel Test

### Purpose

A single test that runs the same random operations against both v1 and v2
providers, producing structured logs, then asserts the logs are identical.

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
deepEqual(logs.v1, logs.v2); // Must be identical
```

---

## 15. Integration Testing

### Where

Integration tests go in `packages/runner/integration/`. They run via
`deno task integration` at the repo root (which also runs integration tests in
shell, cli, patterns, etc.).

### Requirements

- **Must use a real toolshed server** (not emulation). Tests that use emulation
  are regular unit tests, not integration tests.
- **Must pass with MEMORY_VERSION=v2**. This is the success criterion for
  Phase 1.
- **Must verify no v1 code is running**: The v1 code path guard (from
  [section 3](#3-v1v2-coexistence)) will throw if any v1 code is reached.

### Existing Integration Tests

The existing integration tests in `packages/runner/integration/` already test
`syncCell()`, schema traversal, and multi-entity scenarios. These are the
primary verification — getting them to pass with v2 is the goal.

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
13. V1 code path guards
14. Randomized v1/v2 parallel test
15. All existing integration tests passing with `MEMORY_VERSION=v2`

### Phase 2: Optimization

1. JSON Patch optimization (Cell.set → patch operations)
2. Direct Cell.push/remove → splice operations
3. Remove claims from operations that use patches directly

### Phase 3: Advanced Features

1. Branching wired up end-to-end
2. GC scheduling
3. CRDT/OT operations for text

### Order of Implementation Within Phase 1

Suggested order (server first, then client, then tests):

1. **Server handlers** — Memory service, HTTP handlers, route registration.
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
compute a diff. This read creates a claim (read dependency) in the transaction's
history. Consequence: parallel `cell.set()` calls to the same entity always
produce conflict detection — one succeeds, one fails.

This is the correct behavior during Phase 1. In Phase 2, when `Cell.set()`
produces patch operations directly, the implicit claim goes away.

### Double-Notification Prevention

In-process transports (used in emulation mode) deliver responses via
`queueMicrotask()`. This means subscription updates for your OWN commits arrive
BEFORE the commit response. Without filtering, entities get notified twice —
once from the subscription update and once from the commit response.

Prevention strategy:

1. In the subscription update handler, filter out entities that are in pending
   state before calling `integrate()`
2. In the commit response handler, skip entities in pending state from
   notification

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
If entity value came from pending state → reads.pending with localSeq
If entity value came from confirmed state → reads.confirmed with seq
If entity has no local state → reads.confirmed with seq: 0
```

No hash comparison needed. A complex hash comparison algorithm for this routing
is unnecessary complexity.

---

## Appendix A: Required Spec Changes

The following changes to the v2 spec documents (01-06) were needed to align the
spec with architectural decisions made during implementation. Each change is
marked with the spec section it affects.

**Note:** All changes in this appendix have been applied to the spec documents.

### A.1. Drop `hash` from `ConfirmedRead` (03-commit-model.md §3.4)

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
  seq: number;
}
```

Rename `version` → `seq` throughout the spec for consistency.

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
  localSeq: number;
}
```

Add: "The server annotates stored commits with a mapping from `localSeq` to
server-side commit identifiers. This annotation is separate from the signed
payload."

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
