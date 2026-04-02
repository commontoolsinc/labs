# 4. Protocol

The protocol defines how clients communicate with the memory server. The
current implementation uses WebSocket transport, a lightweight JSON
request/response framing layer, and session-scoped catch-up sync frames for
data delivery.

The major protocol change in this revision is that live data updates are no
longer tied to the invocation id of an individual subscription. The server
tracks a session's active watch set and the client's integrated `seenSeq`, then
pushes whatever that session needs to catch up.

## Status Note

This chapter tracks the currently shipped wire behavior for the memory-v2
rewrite. In particular:

- the handshake is `hello` / `hello.ok`, not a bare `{ "protocol": ... }`
  declaration
- request messages are plain JSON envelopes; transport-level UCAN framing
  remains deferred for this pass
- the toolshed v2 websocket route currently requires a signed `session.open`
  payload whose invocation issuer / subject match the requested space DID and
  requested session descriptor
- broader route-level ACL / `Origin` enforcement remains deferred, so the
  endpoint should still be treated as trusted-only
- session resume remains keyed by caller-supplied `(space, sessionId)` rather
  than a server-issued, principal-bound identifier
- the public one-shot read surface is currently `graph.query`
- watch-set mutations return inline `sync` payloads, and steady-state topology
  shrink does not yet guarantee automatic `removes`

## 4.1 Transport

### 4.1.1 WebSocket

The WebSocket transport provides a persistent, bidirectional channel for:

- commands from the client
- final receipts from the server
- session-scoped sync effects from the server

The client MUST declare its protocol version in the first WebSocket message:

```json
{
  "type": "hello",
  "protocol": "memory/v2",
  "flags": {
    "richStorableValues": true,
    "unifiedJsonEncoding": true,
    "canonicalHashing": true,
    "modernSchemaHash": false
  }
}
```

If the server accepts the protocol, it returns:

```json
{
  "type": "hello.ok",
  "protocol": "memory/v2",
  "flags": {
    "richStorableValues": true,
    "unifiedJsonEncoding": true,
    "canonicalHashing": true,
    "modernSchemaHash": false
  }
}
```

If the server does not support the requested version or the advertised flags do
not match what it implements, it returns a typed error response and does not
mark the connection ready.

### 4.1.2 Logical Sessions and Resume

Pending-read resolution, idempotent replay, and live sync are scoped to a
logical session per space rather than to one TCP connection.

```typescript
type SessionId = string;

interface SessionOpenRequest {
  type: "session.open";
  requestId: string;
  space: SpaceId;
  session: {
    sessionId?: SessionId;
    seenSeq?: number;
    sessionToken?: string;
  };
}

interface SessionOpenResult {
  sessionId: SessionId;
  sessionToken: string;
  serverSeq: number;
  resumed?: boolean;
  sync?: SessionSync;
}
```

Rules:

- the client MUST open or resume a session before issuing any memory commands
  for that space on the current connection
- `sessionId` is caller-supplied in the current pass when the client wants to
  resume an existing logical session; server-issued, principal-bound ids remain
  deferred
- `sessionToken` is a server-issued opaque resume capability; clients MUST
  present the latest token when resuming an existing session
- `seenSeq` is the highest canonical seq the client has fully integrated into
  confirmed state
- `resumed: true` means the server found an existing logical session for the
  supplied `(space, sessionId)` pair
- the server rotates `sessionToken` on every successful `session.open`
- at most one connection may own a given `(space, sessionId)` at a time
- a successful resume transfers ownership to the new connection, invalidates the
  old owner for that session, and MAY emit `session/revoked` to the previous
  owner with reason `"taken-over"`
- a stale `sessionToken` MUST fail with `SessionRevokedError`
- when a resumed session already has watches installed, `sync` carries the
  catch-up delta the client missed while offline
- after reconnect, the client resumes the session, replays retained commits,
  applies inline catch-up `sync` when present, and only re-establishes the
  watch set if the session was reopened fresh

## 4.2 Message Format

### 4.2.1 Client → Server: JSON Request Envelope

The current wire protocol uses JSON message envelopes serialized at the wire
boundary with the shared flag-dispatched value codec. The advertised `flags`
reflect the active runtime/storage configuration and the connection MUST fail
loudly if the client and server disagree. `session.open` currently carries the
only signed authorization material in this pass; `transact` carries just the
semantic commit body. Per-commit signed UCAN envelopes remain deferred.

```typescript
interface HelloMessage {
  type: "hello";
  protocol: "memory/v2";
  flags: {
    richStorableValues: boolean;
    unifiedJsonEncoding: boolean;
    canonicalHashing: boolean;
    modernSchemaHash: boolean;
  };
}

interface RequestMessage {
  type:
    | "session.open"
    | "transact"
    | "graph.query"
    | "session.watch.set"
    | "session.watch.add"
    | "session.ack";
  requestId: string;
  space: SpaceId;
  sessionId?: SessionId;
}
```

Per-commit invocation / authorization persistence is deferred in this pass.

### 4.2.2 Server → Client: Response and Session Effect

The server sends:

- `response` for command results
- `session/effect` for catch-up sync on an open logical session
- `session/revoked` when a session loses ownership to a newer connection

```typescript
interface ResponseMessage<Result> {
  type: "response";
  requestId: string;
  ok?: Result;
  error?: { name: string; message: string };
}

interface SessionEffect<Effect> {
  type: "session/effect";
  space: SpaceId;
  sessionId: SessionId;
  effect: Effect;
}

interface SessionRevoked {
  type: "session/revoked";
  space: SpaceId;
  sessionId: SessionId;
  reason: "taken-over";
}
```

Live data delivery is not routed through the initiating request id.

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

### 4.2.4 Batching

The current JSON wire format does not define a separate batch envelope. Clients
issue one request per message in this pass.

## 4.3 Commands

### 4.3.1 `transact` — Write Operations

```typescript
interface TransactRequest {
  type: "transact";
  requestId: string;
  space: SpaceId;
  sessionId: SessionId;
  commit: ClientCommit;
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
  invocationRef: Reference | null;
  authorizationRef: Reference | null;
  revisions: StoredRevision[];
  createdAt: string;
}

type TransactResult =
  | { ok: Commit }
  | { error: ConflictError }
  | { error: TransactionError }
  | { error: AuthorizationError };
```

Path conventions on the wire:

- `ClientCommit` reads and writes use full document paths.
- `readValue` / `writeValue` style helpers are client-side conveniences that
  prepend `"value"` before constructing those commit paths.
- Inline `data:` document reads are local-only. Clients may read them during
  traversal, but must not serialize them into `ClientCommit.reads` because they
  have no server sequence and do not participate in conflict validation.
- query selectors remain value-relative and are re-rooted by the shared
  traversal layer.

### 4.3.2 `query` — Deferred In This Pass

The older simple `/memory/query` surface is not currently exposed on the v2
wire. One-shot reads in this pass use `graph.query` directly.

### 4.3.3 `graph.query` — One-Shot Schema Traversal

`graph.query` performs one-shot schema-guided traversal.

```typescript
type ValuePath = readonly string[];

type ValueSchemaPathSelector = Omit<SchemaPathSelector, "path"> & {
  path: ValuePath;
};

interface GraphQueryRoot {
  id: EntityId;
  selector: ValueSchemaPathSelector;
}

interface GraphQueryRequest {
  type: "graph.query";
  requestId: string;
  space: SpaceId;
  sessionId: SessionId;
  query: {
    roots: GraphQueryRoot[];
    branch?: BranchId;
    atSeq?: number;
  };
}

interface GraphQueryResult {
  serverSeq: number;
  entities: EntitySnapshot[];
}
```

The selector path is relative to `document.value`, not the full stored document
root. The server converts it to a document path by prepending `"value"` before
running shared traversal.

### 4.3.4 `session.watch.set` — Replace the Session Watch Set

The watch set defines the union of queries whose results the session wants kept
up to date.

```typescript
interface WatchSpec {
  id: string;
  kind: "query" | "graph";
  query: GraphQuery;
}

interface WatchSetRequest {
  type: "session.watch.set";
  requestId: string;
  space: SpaceId;
  sessionId: SessionId;
  watches: WatchSpec[];
}

interface WatchSetResult {
  serverSeq: number;
  sync: SessionSync;
}
```

Semantics:

- the provided watch list replaces the entire prior watch set for the session
- the server recomputes the union of watched entities
- the response carries the initial `sync` needed to bring the session cache in
  line with the new interest set
- later committed changes continue to arrive via `session/effect`

### 4.3.5 `session.watch.add` — Extend the Session Watch Set

`session.watch.add` incrementally adds new watch specs into the existing
session watch set by `id`.

```typescript
interface WatchAddRequest {
  type: "session.watch.add";
  requestId: string;
  space: SpaceId;
  sessionId: SessionId;
  watches: WatchSpec[];
}

interface WatchAddResult {
  serverSeq: number;
  sync: SessionSync;
}
```

Semantics:

- each provided watch with a new `id` is added to the existing watch set
- if a provided watch reuses an existing `id` with the same definition, it is a
  no-op
- if a provided watch reuses an existing `id` with a different definition, the
  server rejects the request; clients must use `session.watch.set` to replace
  the full watch set
- new graph watches are evaluated from their new roots only
- traversal stops immediately when it reaches an already tracked
  entity-plus-selector pair
- the server returns the inline `sync` needed for the mutation; pure additive
  growth does not emit `removes`
- in the current pass, `removes` are only guaranteed for explicit watch-set
  replacement; steady-state topology shrink does not yet drive automatic
  unwatch behavior
- watch mutations are applied in order per session; clients must serialize
  `session.watch.set` and `session.watch.add`

### 4.3.6 Branch Lifecycle Commands

Branch create / delete / merge lifecycle commands are not currently exposed on
the v2 wire. The engine already carries branch state internally, but public wire
commands for that surface remain deferred in this pass.

## 4.4 Selectors

Selectors still describe sets of entities or schema-guided traversals. The
protocol change in this revision is not selector syntax; it is the transport
model for delivering live updates.

## 4.5 Authentication

### 4.5.1 Current Pass

Transport-level authentication is only partially implemented in this pass.
Write-class requests may carry `invocation` / `authorization` payloads so they
can be persisted alongside accepted commits, but the current wire protocol
still uses plain JSON envelopes rather than full UCAN message framing.

On the current toolshed websocket route, `session.open` itself is
authenticated:

- the request must carry `invocation` and `authorization`
- `invocation.cmd` must be `"session.open"`
- `invocation.iss` and `invocation.sub` must match the requested `space`
- `invocation.args.session` must match the requested session descriptor
- the signature must verify against the requested space DID

Opening a previously unused space may initialize empty backing storage, but
`session.open` is not itself a logical write or claim.

Broader ACL-based read opens, non-owner session opens, and `Origin` checks are
still future work on the v2 websocket route, so the endpoint remains
trusted-only for now.

### 4.5.2 Future Target

The longer-term target is still UCAN-authorized memory commands. When that
cutover lands, the invocation object will define the command and the
authorization object will prove that
the issuer was allowed to submit it. Successful write-class commands persist
both references for later audit.

### 4.5.3 Space Authorization

When transport-level authorization lands, read commands will require read
access and write-class commands will require write access.

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

In the current pass, that `removes` guarantee only applies to explicit
watch-set replacement. Steady-state topology shrink during background refresh
does not yet drive automatic unwatch behavior.

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

All errors are returned in `response`.

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
