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
- the toolshed v2 websocket route requires a signed `session.open`
  invocation whose subject, challenge, audience, and session descriptor match
  the current request
- the server ACL policy gates session opens and commands when enabled
- fresh spaces require a space-identity- or service-authorized ACL genesis
  transaction before ordinary writes
- route-level `Origin` enforcement remains deferred
- session resume remains keyed by caller-supplied `(space, sessionId)` rather
  than a server-issued, principal-bound identifier
- the public one-shot read surfaces are `graph.query` and `entity-id.list`
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
    "modernCellRep": true,
    "persistentSchedulerState": true,
    "entityIdListing": true
  }
}
```

If the server accepts the protocol, it returns:

```json
{
  "type": "hello.ok",
  "protocol": "memory/v2",
  "flags": {
    "modernCellRep": true,
    "persistentSchedulerState": true,
    "entityIdListing": true
  },
  "sessionOpen": {
    "audience": "did:key:z6Mk...",
    "challenge": {
      "value": "64 hex characters",
      "expiresAt": 1760000000
    }
  }
}
```

If the server does not support the requested version or the required data-model
flags do not match what it implements, it returns a typed error response and
does not mark the connection ready.

Memory hosts include `sessionOpen.audience` and `sessionOpen.challenge` in
`hello.ok`. The audience is the server DID the client must sign for. Toolshed
uses its service identity DID. The standalone memory host uses a stable
deterministic DID. The public memory client rejects a server that omits either
field.

#### Server Audience Ownership

The audience value identifies the memory server or service that may accept the
signed `session.open`. It is part of the signed invocation, so changing it
invalidates signatures made for the old value.

Production toolshed deployments own this value through the toolshed service
identity. That DID must be stable across restarts and across horizontally scaled
instances that serve the same logical memory endpoint. All instances behind one
toolshed memory endpoint must advertise the same audience. Otherwise a client
can sign for one instance and fail when routing sends it to another instance.

Changing the toolshed service DID is an audience rotation. During rotation,
clients must discover the new value from `hello.ok` and sign new `session.open`
requests for it. Existing open sessions can continue only while their
connection remains alive and keeps using challenges issued by the server that
accepted them. Reconnects and new sessions must use the new audience. Operators
should coordinate rotation with deployment routing and client reconnect
behavior.

Standalone and test memory hosts may use a deterministic local DID, but they
still need to advertise an audience. The public client treats a missing audience
as a protocol error.

The challenge is scoped to this WebSocket connection. The current
implementation generates 32 cryptographically random bytes and encodes them as
64 hexadecimal characters. The challenge expires at `expiresAt`, in unix
seconds. The client signs the challenge and audience into the next
`session.open` invocation. The server accepts the current challenge only once.
After a successful `session.open`, the response includes a new
`sessionOpen.challenge`. The client uses that new challenge for the next
`session.open` on the same connection.

`persistentSchedulerState` advertises whether the runner and memory server are
allowed to write and serve internal scheduler observations. It defaults to
`false` when absent. When `false`, clients should not send scheduler observation
payloads, servers ignore scheduler observation payloads if received, and
snapshot-list requests return no scheduler snapshots even if older scheduler
rows exist in the database. This flag is negotiated as an optional capability:
a client and server may connect when their scheduler-state flags differ, and
the server's flag controls the scheduler-observation data plane for that
connection.

`entityIdListing` advertises support for `entity-id.list`. It defaults to
`false` when absent. A client must not send the request unless the server
advertises the capability.

### 4.1.2 Logical Sessions and Resume

Pending-read resolution, idempotent replay, and live sync are scoped to a
logical session per space rather than to one TCP connection.

```typescript
// Shown at module scope.
type SessionId = string;
type SignatureBytes = Uint8Array;

interface SessionOpenRequest {
  type: "session.open";
  requestId: string;
  space: SpaceId;
  session: {
    sessionId?: SessionId;
    seenSeq?: number;
    sessionToken?: string;
  };
  invocation?: SessionOpenInvocation;
  authorization?: {
    signature: SignatureBytes;
  };
}

interface SessionOpenInvocation {
  iss: DID;
  cmd: "session.open";
  sub: SpaceId;
  aud: DID;
  args: {
    protocol: "memory/v2";
    session: {
      sessionId?: SessionId;
      seenSeq?: number;
      sessionToken?: string;
    };
  };
  challenge: string;
  iat: number;
  exp: number;
}

interface SessionOpenResult {
  sessionId: SessionId;
  sessionToken: string;
  serverSeq: number;
  resumed?: boolean;
  sync?: SessionSync;
  sessionOpen: {
    challenge: {
      value: string;
      expiresAt: number;
    };
    audience: string;
  };
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
- a successful `session.open` rotates the one-time connection challenge and
  returns the next challenge in `sessionOpen`
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
// Shown at module scope.
interface HelloMessage {
  type: "hello";
  protocol: "memory/v2";
  flags: {
    modernCellRep: boolean;
    persistentSchedulerState?: boolean;
    entityIdListing?: boolean;
  };
}

interface RequestMessage {
  type:
    | "session.open"
    | "transact"
    | "graph.query"
    | "entity-id.list"
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
// Shown at module scope.
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
// Shown at module scope.
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
// Shown at module scope.
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
// Shown at module scope.
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

### 4.3.4 `entity-id.list` — List Live Entity Identifiers

`entity-id.list` returns the identifiers of live entities in the default branch
and space scope. The server reads the current entity index and does not select
or return stored entity values. The result is sorted by identifier.

```typescript
// Shown at module scope.
interface EntityIdListRequest {
  type: "entity-id.list";
  requestId: string;
  space: SpaceId;
  sessionId: SessionId;
}

interface EntityIdListResult {
  serverSeq: number;
  ids: EntityId[];
}
```

The command requires `READ` access to the space. Deleted entities, user-scoped
entities, and session-scoped entities do not appear in the result.

### 4.3.5 `session.watch.set` — Replace the Session Watch Set

The watch set defines the union of queries whose results the session wants kept
up to date.

```typescript
// Shown at module scope.
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

### 4.3.6 `session.watch.add` — Extend the Session Watch Set

`session.watch.add` incrementally adds new watch specs into the existing
session watch set by `id`.

```typescript
// Shown at module scope.
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

### 4.3.7 Branch Lifecycle Commands

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

On memory WebSocket routes, `session.open` itself is authenticated:

- the request must carry `invocation` and `authorization`
- `invocation.cmd` must be `"session.open"`
- `invocation.iss` must be a DID whose signature verifies
- `invocation.sub` must match the requested `space`
- `invocation.args.session` must match the requested session descriptor
- `invocation.args.protocol` must be the memory protocol
- `invocation.challenge` must match the current connection challenge
- the challenge must still be live
- the challenge must not have been used already on this connection
- `invocation.aud` must match the server audience from `hello.ok`
- `invocation.iat` and `invocation.exp` are signed into the invocation
- `invocation.exp` must not be expired beyond the server clock-skew grace
- the signature must verify against `invocation.iss` for the hash of
  `invocation`

Opening a previously unused space may initialize empty backing storage, but
`session.open` is not itself a logical write or claim.

When ACL policy is active, the authenticated principal is evaluated against
the space ACL document (wire entity id `of:<space DID>`) for every command:

| Stored ACL state | Effective access |
| --- | --- |
| valid ACL with a concrete OWNER | Explicit principal grant, then `"*"`; normal READ < WRITE < OWNER ordering |
| never-created ACL, server sequence 0 | Authenticated READ only; the first write must be a valid ACL-only genesis by the space identity or a service DID |
| never-created ACL, server sequence greater than 0 | Temporary pre-launch compatibility: authenticated READ and WRITE, never OWNER |
| malformed, ownerless, or retracted ACL | No ordinary access (fail closed) |

The exact space DID and configured service DIDs retain implicit OWNER so they
can initialize or repair ACL state. A valid ACL mutation is a whole-document,
space-scoped replacement on the default branch and must retain at least one
concrete (non-`"*"`) OWNER. Patch, deletion, mixed ACL/data commits, and
last-owner removal are rejected. These shape and genesis rules are hard
storage invariants in both `observe` and `enforce`; `observe` relaxes only
ordinary capability shortfalls on an already valid ACL.

Genesis remains an explicit transaction. For a fresh named space, the storage
manager briefly authenticates as the derived space identity, writes
`{ [activeUser]: "OWNER", "*": "WRITE" }` against a confirmed absent ACL,
closes that bootstrap session, and mounts the durable session as the active
user. The wildcard grant is the rollout default until ACL management has a UI;
the active user remains the concrete owner who can later narrow it. This
preserves user/session-scoped partitioning. When the active identity already is
the space DID (the home space), the same flow instead writes
`{ [space]: "OWNER" }`; that narrow path also privatizes a populated legacy
home with no ACL. Populated named spaces with no ACL remain public under the
compatibility row above.

The server's unauthenticated `writeDocument` operator path cannot create a
fresh space or mutate the ACL document while ACL policy is active. Its access
to ordinary documents in an already-created space remains a known deferred
blob-authorization issue.

The challenge protects against replay of a captured signed `session.open` after
the original WebSocket handshake has moved on.
It also limits a captured open to the connection that received the challenge.
Audience binding protects against replaying an open signed for one memory host
to another memory host.

This does not prevent every relay attack.
A fully interactive relay can still forward the server challenge to a signer
and forward the signed result back to the same server.
The user or calling code still needs to intend the operation it signs.
Transport security, origin checks, and product-level signing prompts remain
part of the complete security boundary.

The memory protocol does not add encryption above WebSocket.
Remote deployments must expose the route over `wss` or another TLS-protected
transport.
Plain `ws` is only appropriate for local development or a trusted private
transport.

Broader ACL-based read opens and non-owner session opens are implemented by the
server ACL policy when enabled.
Route-level `Origin` checks remain future work on the v2 websocket route.

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
// Shown at module scope.
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
// Shown at module scope.
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
// Shown at module scope.
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
