# 4. Protocol

The protocol defines how clients communicate with the memory server. It uses
WebSocket transport, signed UCAN invocations for client commands, `task/return`
receipts for command results, and session-scoped catch-up sync frames for data
delivery.

The major protocol change in this revision is that live data updates are no
longer tied to the invocation id of an individual subscription. The server
tracks a session's active watch set and the client's integrated `seenSeq`, then
pushes whatever that session needs to catch up.

## 4.1 Transport

### 4.1.1 WebSocket

The WebSocket transport provides a persistent, bidirectional channel for:

- commands from the client
- final receipts from the server
- session-scoped sync effects from the server

The client MUST declare its protocol version in the first WebSocket message:

```json
{ "protocol": "memory/v2" }
```

If the server does not support the requested version, it returns:

```json
{ "error": { "name": "UnsupportedProtocol", "supported": ["memory/v2"] } }
```

### 4.1.2 Logical Sessions and Resume

Pending-read resolution, idempotent replay, and live sync are scoped to a
logical session per space rather than to one TCP connection.

```typescript
type SessionId = string;

interface SessionOpenCommand {
  cmd: "/memory/session/open";
  sub: SpaceId;
  args: {
    sessionId?: SessionId;
    seenSeq?: number;
  };
}

interface SessionOpenResult {
  ok: {
    sessionId: SessionId;
    serverSeq: number;
  };
}
```

Rules:

- the client MUST open or resume a session before issuing any memory commands
  for that space on the current connection
- `sessionId` is server-issued and bound to the authenticated principal and
  space
- `seenSeq` is the highest canonical seq the client has fully integrated into
  confirmed state
- after reconnect, the client resumes the session, replays retained commits,
  re-establishes the session watch set, and then receives catch-up sync newer
  than `seenSeq`

## 4.2 Message Format

### 4.2.1 Client → Server: UCAN Invocation

Every client message is a signed UCAN invocation.

```typescript
interface ClientMessage<Cmd extends Command = Command> {
  invocation: Cmd;
  authorization: Authorization<Cmd>;
}

interface Command<
  Ability extends string = string,
  Subject extends SpaceId = SpaceId,
  Args extends Record<string, unknown> = Record<string, unknown>,
> {
  cmd: Ability;
  sub: Subject;
  args: Args;
  iss: DID;
  prf: Delegation[];
  iat?: number;
  exp?: number;
  nonce?: Uint8Array;
  meta?: Record<string, string>;
}
```

Successful write-class commands preserve both the canonical invocation object
and the verified authorization object in storage.

### 4.2.2 Server → Client: Receipt and Session Effect

The server sends:

- `task/return` for command results
- `session/effect` for catch-up sync on an open logical session

```typescript
interface TaskReturn<Result> {
  the: "task/return";
  of: InvocationId;
  is: Result;
}

interface SessionEffect<Effect> {
  the: "session/effect";
  sessionId: SessionId;
  is: Effect;
}

type InvocationId = `job:${string}`;
```

The server MAY continue to expose invocation ids for commands, but live data
delivery is not routed through the initiating command's invocation id.

### 4.2.3 Session Sync Payload

```typescript
interface SessionSync {
  type: "sync";
  fromSeq: number;
  toSeq: number;
  upserts: Array<{
    branch: BranchId;
    id: EntityId;
    seq: number;
    doc?: EntityDocument;
    deleted?: true;
  }>;
  removes: Array<{
    branch: BranchId;
    id: EntityId;
  }>;
}
```

Semantics:

- `upserts` carry the latest state each watched entity should have after
  integrating `toSeq`
- `deleted: true` means the entity is currently tombstoned
- `removes` are not deletions in storage; they mean the entity is no longer in
  the session's relevant watch-set result

### 4.2.4 Batch Invocations

Multiple invocations can still be batched into one signed message. Batching
optimizes signature overhead, not atomicity.

## 4.3 Commands

### 4.3.1 `transact` — Write Operations

```typescript
interface TransactCommand {
  cmd: "/memory/transact";
  sub: SpaceId;
  args: {
    localSeq: number;
    reads: {
      confirmed: ConfirmedRead[];
      pending: PendingRead[];
    };
    operations: Operation[];
    codeCID?: Reference;
    branch?: BranchId;
    merge?: MergeContext;
  };
}

interface Commit {
  seq: number;
  branch: BranchId;
  sessionId: SessionId;
  localSeq: number;
  original: ClientCommit | BranchLifecycleWrite;
  resolution: {
    seq: number;
    resolvedPendingReads?: Array<{ localSeq: number; seq: number }>;
  };
  invocationRef: Reference;
  authorizationRef: Reference;
  revisions: StoredRevision[];
  createdAt: string;
}

type TransactResult =
  | { ok: Commit }
  | { error: ConflictError }
  | { error: TransactionError }
  | { error: AuthorizationError };
```

### 4.3.2 `query` — One-Shot Query

`query` remains the one-shot path for simple reads.

```typescript
interface QueryCommand {
  cmd: "/memory/query";
  sub: SpaceId;
  args: {
    select: Selector;
    branch?: BranchId;
    since?: number;
    atSeq?: number;
  };
}

interface QueryResult {
  ok: FactSet;
}
```

### 4.3.3 `graph.query` — One-Shot Schema Traversal

`graph.query` performs one-shot schema-guided traversal.

```typescript
interface GraphQueryCommand {
  cmd: "/memory/graph/query";
  sub: SpaceId;
  args: {
    selectSchema: SchemaSelector;
    branch?: BranchId;
    since?: number;
    atSeq?: number;
  };
}

interface GraphQueryResult {
  ok: FactSet;
}
```

### 4.3.4 `session.watch.set` — Replace the Session Watch Set

The watch set defines the union of queries whose results the session wants kept
up to date.

```typescript
interface WatchSpec {
  id: string;
  kind: "query" | "graph";
  query: Query | SchemaQuery;
}

interface WatchSetCommand {
  cmd: "/memory/session/watch/set";
  sub: SpaceId;
  args: {
    watches: WatchSpec[];
  };
}

interface WatchSetResult {
  ok: {
    watches: string[];
    serverSeq: number;
  };
}
```

Semantics:

- the provided watch list replaces the entire prior watch set for the session
- the server recomputes the union of watched entities
- after the watch set is installed, the server emits `session/effect` sync to
  bring the session cache in line with the new interest set

### 4.3.5 `session.watch.add` — Extend the Session Watch Set

`session.watch.add` incrementally merges new watch specs into the existing
session watch set by `id`.

```typescript
interface WatchAddCommand {
  cmd: "/memory/session/watch/add";
  sub: SpaceId;
  args: {
    watches: WatchSpec[];
  };
}

interface WatchAddResult {
  ok: {
    watches: string[];
    serverSeq: number;
  };
}
```

Semantics:

- each provided watch is merged into the existing watch set by `id`
- new graph watches are evaluated from their new roots only
- traversal stops immediately when it reaches an already tracked
  entity-plus-selector pair
- the server returns only the additional `upserts` needed for the new watches;
  pure adds do not emit `removes`
- watch mutations are applied in order per session; clients must serialize
  `session.watch.set` and `session.watch.add`

### 4.3.6 Branch Lifecycle Commands

Branch create, merge preparation, delete, and list remain protocol commands.
They continue to use `localSeq` for replay safety when they mutate storage.

```typescript
interface CreateBranchCommand {
  cmd: "/memory/branch/create";
  sub: SpaceId;
  args: {
    localSeq: number;
    name: BranchName;
    fromBranch?: BranchName;
    atSeq?: number;
  };
}

interface DeleteBranchCommand {
  cmd: "/memory/branch/delete";
  sub: SpaceId;
  args: {
    localSeq: number;
    name: BranchName;
  };
}
```

Merge preparation continues to return a proposal that the client wraps in a
normal `/memory/transact`.

## 4.4 Selectors

Selectors still describe sets of entities or schema-guided traversals. The
protocol change in this revision is not selector syntax; it is the transport
model for delivering live updates.

## 4.5 Authentication

### 4.5.1 UCAN Structure

All commands are authorized via UCAN. The server verifies:

- the signature
- the delegation chain
- the command ability
- the target subject/space

### 4.5.2 Authorization Flow

The invocation object defines the command. The authorization object proves that
the issuer was allowed to submit it. Successful write-class commands persist
both references for later audit.

### 4.5.3 Space Authorization

Read commands require read access. Write-class commands require write access.

## 4.6 Session Sync Delivery

When a successful commit or watch-set change affects the entities relevant to a
session, the server pushes a `session/effect`.

### 4.6.1 Delivery Model

The server maintains, per session:

- the active watch set
- the highest integrated `seenSeq`
- the current session cache or enough metadata to compute deltas

The live-sync contract is:

1. determine which entities are relevant to the session's current watch union
2. compare that relevant set with what the session has already integrated
3. send one or more `SessionSync` frames to bring the session up to date

### 4.6.2 Overlap and Deduplication

Because the watch set is a union, overlapping watches dedupe naturally:

- one entity appears once in the session cache even if many watches include it
- one sync frame can satisfy many overlapping watches
- the client derives per-watch views locally from the session cache

### 4.6.3 Watch Changes

When the client replaces the watch set:

- newly relevant entities are sent as `upserts`
- entities no longer relevant are sent as `removes`
- entities still relevant but unchanged are not resent unless needed for
  catch-up

### 4.6.4 Cross-Session Delivery

Commits from one session must still trigger sync for all other sessions whose
watch unions are affected.

### 4.6.5 Commit Notification Model

The runtime-facing scheduler rules remain the same:

1. optimistic local commit fires one synchronous `commit` notification
2. server rejection fires a later `revert`
3. externally integrated or newly confirmed server data fires `integrate` only
   when it becomes visible beyond any newer local pending shadowing

## 4.7 Error Responses

All errors are returned in `task/return`.

```typescript
interface ConflictError extends Error {
  name: "ConflictError";
  commit: ClientCommit;
  conflicts: ConflictDetail[];
}

interface TransactionError extends Error {
  name: "TransactionError";
  cause: SystemError;
}

interface QueryError extends Error {
  name: "QueryError";
  cause: SystemError;
}

interface AuthorizationError extends Error {
  name: "AuthorizationError";
}

interface ConnectionError extends Error {
  name: "ConnectionError";
  cause: SystemError;
}

interface RateLimitError extends Error {
  name: "RateLimitError";
  retryAfter: number;
}
```

## 4.8 Client Library API

### 4.8.1 Connection

```typescript
interface MountOptions {
  sessionId?: SessionId;
  seenSeq?: number;
}

interface MemorySession {
  mount(space: SpaceId, options?: MountOptions): SpaceSession;
  close(): void;
}
```

### 4.8.2 Space Session

```typescript
interface SpaceSession {
  transact(
    args: ClientCommit,
  ): Promise<Result<Commit, ConflictError | TransactionError>>;
  query(args: Query): Promise<FactSet>;
  graphQuery(args: SchemaQuery): Promise<FactSet>;
  watchSet(watches: WatchSpec[]): Promise<{ serverSeq: number }>;
  close(): void;
}
```

### 4.8.3 Session Cache and Derived Views

The client library maintains one session cache per mounted space:

- confirmed entities integrated through `seenSeq`
- local pending commits layered above that cache
- derived per-watch query results computed locally

An implementation MAY still expose convenience methods named `subscribe()` at
the client API level, but they are library constructs built on `watchSet()` and
the session cache rather than distinct server-routed effect streams.

### 4.8.4 Session Lifecycle

On disconnect:

1. pending promises reject with `ConnectionError`
2. the logical session may still be resumable
3. the client reconnects, replays retained commits, restores the watch set, and
   resumes integrating sync from `seenSeq`

## 4.9 Blob Transfer

Blob bytes are transferred through dedicated HTTP endpoints. Blob references in
entity values remain content-addressed.

## 4.10 Branch Parameter

`branch` on read and write commands still determines which branch is being read
or mutated. If omitted, the default branch is used.

## 4.11 Message Ordering

### 4.11.1 Client-Side Ordering

Clients MUST:

- submit pending commits in increasing `localSeq` order per logical session
- integrate `SessionSync` frames in increasing `toSeq` order
- buffer incoming sync while building a transaction so one transaction observes
  one stable snapshot

### 4.11.2 Server-Side Ordering

The server processes writes serially within a branch, or with equivalent
serializable isolation.

For live sync:

- the server MAY coalesce multiple successful commits into one `SessionSync`
  frame
- before returning `ConflictError`, the server MUST first flush any already
  committed relevant changes that would otherwise leave the client's subscribed
  view stale
- the server SHOULD carry dirty-document information through this flush so it
  only recomputes affected watch unions

## 4.12 Mapping from Current Implementation

| Current shape                              | New shape                                                 | Notes                                                     |
| ------------------------------------------ | --------------------------------------------------------- | --------------------------------------------------------- |
| `task/effect` tied to `query.subscribe`    | `session/effect` tied to `sessionId`                      | Live sync is session-scoped rather than invocation-scoped |
| Per-subscription routing                   | Watch-set union + session cache                           | Overlap is deduped at the session layer                   |
| Re-subscribe each live query independently | Restore one watch set                                     | The client still restores interests after reconnect       |
| Hash-centric semantic commit identity      | `(sessionId, localSeq)` before accept, `seq` after accept | UCAN envelope refs remain content-addressed               |
