# 4. Protocol

The protocol defines how clients communicate with the memory server. It
specifies the transport layer, message format, available commands, authentication
model, and the client library surface.

Two transports are supported: **WebSocket** (primary, bidirectional, supports
subscriptions) and **HTTP** (stateless fallback for simple reads and writes).

---

## 4.1 Transport

### 4.1.1 WebSocket (Primary)

The WebSocket transport provides a persistent, bidirectional channel between
client and server. It supports all commands, including subscriptions that
deliver real-time updates.

**Connection**: The client initiates a WebSocket connection to the server. The
server upgrades the HTTP request and establishes a session. The session persists
until either side closes the connection.

```
Client                              Server
  |                                    |
  |  HTTP Upgrade: websocket           |
  |  --------------------------------→ |
  |  101 Switching Protocols           |
  |  ←-------------------------------- |
  |                                    |
  |  ← bidirectional message stream →  |
  |                                    |
```

**Message flow**: Messages are JSON-encoded strings. The client sends
**requests** (commands wrapped in UCAN invocations). The server sends
**responses** (`task/return` receipts) and **effects** (`task/effect` for
subscription updates). Every request has a deterministic invocation ID (derived
from its content hash) that correlates responses back to requests.

### 4.1.2 HTTP (Fallback)

The HTTP transport is stateless and does not support subscriptions. It is
suitable for simple read/write operations and environments where WebSocket
connections are impractical.

| Operation | Method | Path | Body |
|-----------|--------|------|------|
| Transact  | `PATCH` | `/` | `Transaction` JSON |
| Query     | `POST`  | `/` | `Query` JSON |

HTTP responses use standard status codes:

| Code | Meaning |
|------|---------|
| 200  | Success |
| 400  | Malformed request |
| 401  | Authentication failed |
| 403  | Authorization denied |
| 409  | Conflict (transaction rejected) |
| 503  | Server error (storage failure) |

---

## 4.2 Message Format

All WebSocket messages are JSON-encoded. The protocol uses two message types
from the server and one envelope type from the client.

### 4.2.1 Client → Server: UCAN Invocation

Every client message is a signed UCAN invocation. The invocation contains the
command and its arguments, plus the authorization proof.

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
  cmd: Ability;           // The command identifier, e.g. "/memory/transact"
  sub: Subject;           // The target space (DID)
  args: Args;             // Command-specific arguments
  iss: DID;               // Issuer — who is sending this command
  prf: Delegation[];      // Proof chain — delegation from subject to issuer
  iat?: number;           // Issued-at (Unix timestamp, seconds)
  exp?: number;           // Expiration (Unix timestamp, seconds)
  nonce?: Uint8Array;     // Optional nonce for uniqueness
  meta?: Record<string, string>; // Optional metadata
}
```

The **invocation ID** is computed as `job:<content-hash>` where the content hash
is the merkle reference of the invocation object. This ID is deterministic and
used to correlate responses.

### 4.2.2 Server → Client: Receipt

A receipt is the server's response to a command. It can be a final result
(`task/return`) or a subscription update (`task/effect`).

```typescript
// Final result for a command
interface TaskReturn<Result> {
  the: "task/return";
  of: InvocationId;    // "job:<hash>" — correlates to the request
  is: Result;          // The result payload (Ok or Error)
}

// Subscription update (pushed by server)
interface TaskEffect<Effect> {
  the: "task/effect";
  of: InvocationId;    // The subscription's invocation ID
  is: Effect;          // The update payload
}

type Receipt<Result, Effect> = TaskReturn<Result> | TaskEffect<Effect>;

// Invocation ID format
type InvocationId = `job:${string}`;
```

---

## 4.3 Commands

### 4.3.1 `transact` — Write Operations

Submit a transaction containing one or more operations. The server validates
all read dependencies and applies writes atomically (see section 3).

```typescript
// Command
interface TransactCommand {
  cmd: "/memory/transact";
  sub: SpaceId;
  args: {
    reads: {
      confirmed: ConfirmedRead[];
      pending: PendingRead[];
    };
    operations: Operation[];
    codeCID?: Reference;
    branch?: BranchId;
  };
}

// The `args` field carries a ClientCommit (see §3.4). The Transaction type
// from §3.2 is a simplified form used for documentation; the wire format
// always includes the `reads` field.

// Success response
interface TransactSuccess {
  ok: Commit;  // The recorded commit, including version assignment
}

// Commit — the server's response after a successful transaction
interface Commit {
  hash: Reference;       // Content hash of the commit
  version: number;       // Server-assigned version number
  branch: BranchId;      // Branch the commit was applied to
  facts: StoredFact[];   // Facts produced by this commit
  createdAt: string;     // ISO-8601 timestamp
}

// Error responses
type TransactError =
  | { error: ConflictError }
  | { error: TransactionError }
  | { error: AuthorizationError };
```

The `Commit` in the success response includes the version number, the facts
produced, the commit hash, and the target branch. This gives the client
everything it needs to move the affected entities from pending to confirmed.

### 4.3.2 `query` — Read Entities

Read entities matching a selector pattern. Returns the current state of all
matching entities.

```typescript
// Command
interface QueryCommand {
  cmd: "/memory/query";
  sub: SpaceId;
  args: {
    select: Selector;     // Pattern to match entities
    since?: number;        // Only return facts newer than this version
    branch?: BranchId;     // Target branch (default if omitted)
  };
}

// Success response
interface QuerySuccess {
  ok: FactSet;  // Set of matching facts with their current values and versions
}

// Error responses
type QueryError =
  | { error: QueryError }
  | { error: AuthorizationError };
```

The `since` parameter enables efficient incremental reads: "give me everything
that changed since version N." The server returns only facts with
`version > since`.

### 4.3.3 `query.subscribe` — Subscribe to Changes

Subscribe to ongoing changes matching a selector. The server sends an initial
result set (same as `query`), then pushes incremental updates as matching
entities change.

```typescript
// Command
interface SubscribeCommand {
  cmd: "/memory/query/subscribe";
  sub: SpaceId;
  args: {
    select: Selector;     // Pattern to match
    since?: number;        // Initial cursor
    branch?: BranchId;
  };
}

// Initial response (task/return)
interface SubscribeSuccess {
  ok: FactSet;  // Initial result set
}

// Subsequent updates (task/effect, pushed by server)
interface SubscriptionUpdate {
  commit: Commit;            // The commit that produced the changes
  revisions: StoredFact[];   // Changed facts matching the subscription
}
```

Subscription updates are delivered as `task/effect` messages with the same
invocation ID as the original subscribe command. The client uses this ID to
route updates to the correct subscription handler.

**Lifecycle**: A subscription remains active until the client sends
`query.unsubscribe` or the WebSocket connection closes. The server tracks
active subscriptions per session.

### 4.3.4 `query.unsubscribe` — Cancel a Subscription

Cancel an active subscription. The server stops sending updates and cleans up
subscription state.

```typescript
// Command
interface UnsubscribeCommand {
  cmd: "/memory/query/unsubscribe";
  sub: SpaceId;
  args: {
    source: InvocationId;  // The invocation ID of the subscribe command
  };
}

// Response
interface UnsubscribeSuccess {
  ok: {};
}
```

After unsubscribing, the server sends a `task/return` for both the unsubscribe
command (confirming it) and the original subscribe command (signaling its
completion).

### 4.3.5 `graph.query` — Schema-Driven Traversal

Query entities by following schema-defined references. Unlike `query`, which
matches by entity ID patterns, `graph.query` starts from seed entities and
traverses their schema-defined relationships to discover related entities.

```typescript
// Command
interface GraphQueryCommand {
  cmd: "/memory/graph/query";
  sub: SpaceId;
  args: {
    selectSchema: SchemaSelector;  // Starting points + schema for traversal
    since?: number;                // Version cursor
    subscribe?: boolean;           // If true, also subscribe to changes
    excludeSent?: boolean;         // If true, omit already-sent entities
    branch?: BranchId;
  };
}

// Schema selector structure — maps entity IDs to schema path selectors
type SchemaSelector = Record<EntityId | "*", SchemaPathSelector>;

interface SchemaPathSelector {
  path: readonly string[];   // JSON path from fact root to start traversal
  schema?: JSONSchema;       // Schema defining the structure and references
}

// Response: same shape as query
interface GraphQuerySuccess {
  ok: FactSet;  // All discovered facts (seed entities + traversed references)
}
```

When `subscribe: true`, the server tracks which entities are reachable from the
query's schema graph. When any reachable entity changes, the server re-evaluates
the affected portion of the graph and pushes updates (as `task/effect`). See
section 5 (Queries) for details on schema traversal.

### 4.3.6 Branch Lifecycle Commands

Commands for creating, merging, deleting, and listing branches. See section 6
(Branching) for full semantics.

```typescript
// Create a new branch
interface CreateBranchCommand {
  cmd: "/memory/branch/create";
  sub: SpaceId;
  args: {
    name: BranchName;            // Name for the new branch
    fromBranch?: BranchName;     // Branch to fork from (default branch if omitted)
    atVersion?: number;          // Version to fork at (head if omitted)
  };
}

interface CreateBranchResult {
  ok: {
    name: BranchName;
    forkedFrom: BranchName;
    atVersion: number;
  };
}

// Merge a branch into another
interface MergeBranchCommand {
  cmd: "/memory/branch/merge";
  sub: SpaceId;
  args: {
    source: BranchName;         // Branch to merge from
    target: BranchName;         // Branch to merge into
    resolutions?: Record<EntityId, JSONValue | null>;  // Manual conflict resolutions
  };
}

interface MergeBranchResult {
  ok: {
    commit: Commit;             // The merge commit on the target branch
    merged: number;             // Number of entities merged
  };
}

// Delete a branch
interface DeleteBranchCommand {
  cmd: "/memory/branch/delete";
  sub: SpaceId;
  args: {
    name: BranchName;           // Branch to delete
  };
}

// Response: { ok: {} }

// List branches
interface ListBranchesCommand {
  cmd: "/memory/branch/list";
  sub: SpaceId;
  args: {
    includeDeleted?: boolean;   // Include soft-deleted branches (default: false)
  };
}

interface ListBranchesResult {
  ok: {
    branches: BranchInfo[];
  };
}

interface BranchInfo {
  name: BranchName;
  headVersion: number;
  createdAt: string;
  deletedAt?: string;
}
```

---

## 4.4 Selectors

A **Selector** defines a pattern for matching entities. It uses a two-level
structure: entity ID to match specification. The entity ID can be a specific ID
or `"*"` to match all entities. The match specification can optionally filter by
parent hash.

```typescript
type Selector = Record<EntityId | "*", EntityMatch>;

interface EntityMatch {
  parent?: Reference | "*";  // Optional parent filter ("*" = any)
}
```

Examples:

```typescript
// Select a specific entity (current head)
const specific: Selector = {
  "urn:entity:abc123": {}
};

// Select all entities
const all: Selector = {
  "*": {}
};

// Select a specific entity at a specific version (by parent hash)
const versioned: Selector = {
  "urn:entity:abc123": { parent: "baedrei...hash" }
};
```

---

## 4.5 Authentication

All commands are authenticated using **UCAN** (User Controlled Authorization
Networks). Each request is a signed invocation proving the issuer's authority
to act on the target space.

### 4.5.1 UCAN Structure

```typescript
interface UCAN<Cmd extends Command> {
  invocation: Cmd;
  authorization: Authorization<Cmd>;
}

interface Authorization<T> {
  signature: Signature<Proof<T>>;  // Cryptographic signature
  access: Proof<T>;                // Proof of access
}

interface Proof<Access> {
  [link: string]: {};  // References to the access being proven
}
```

### 4.5.2 Authorization Flow

1. **Client constructs** the command (invocation)
2. **Client computes** the content hash of the invocation → invocation reference
3. **Client signs** the invocation reference with its private key
4. **Client sends** `{ invocation, authorization }` to the server
5. **Server verifies** the signature against the issuer's public key (DID)
6. **Server checks** that the issuer has permission to act on the target space
   (via delegation chain or ACL)

### 4.5.3 Space Authorization

The **subject** (`sub`) of every command is a space DID. The server checks
whether the issuer (`iss`) is authorized to perform the requested operation
on that space.

Authorization sources, checked in order:

1. **Identity**: The issuer IS the space (the space's DID matches the issuer's
   DID). This grants full owner access.
2. **Delegation**: The issuer presents a UCAN delegation chain from the space
   owner granting specific capabilities. *(Future — not yet implemented.)*
3. **ACL**: The space has an Access Control List entity that maps DIDs to
   capability levels.

```typescript
type Capability = "READ" | "WRITE" | "OWNER";

type ACL = {
  [did: DID | "*"]?: Capability;
};
```

The `"*"` key grants access to any authenticated principal. Capability levels
are hierarchical: `OWNER` implies `WRITE`, which implies `READ`.

| Command | Required Capability |
|---------|---------------------|
| `query`, `query.subscribe`, `graph.query` | `READ` |
| `transact` | `WRITE` |
| `branch/create`, `branch/merge`, `branch/delete` | `WRITE` |
| ACL modifications | `OWNER` |

The ACL is stored as a regular entity at the well-known ID
`urn:acl:<space-did>`. It is a JSON object mapping DIDs to capability levels.
ACL modifications require `OWNER` capability and follow the normal commit path
(transact with a set operation on the ACL entity).

---

## 4.6 Subscription Delivery

When a commit affects entities matching an active subscription, the server
pushes an update to the subscriber.

### 4.6.1 Update Contents

The subscription update includes:

1. The **commit** that produced the changes (for provenance and version tracking)
2. The **revisions** — the new facts matching the subscription's selector

```typescript
interface SubscriptionUpdate {
  commit: Commit;            // The commit record
  revisions: StoredFact[];   // Facts matching this subscription
}
```

For schema-based subscriptions (`graph.query` with `subscribe: true`), the
server also re-evaluates the schema graph to discover newly reachable entities
and includes those in the update.

### 4.6.2 Deduplication

The server tracks the last version sent to each subscription. If a fact was
already sent in a previous update (same entity, same or older version), it is
not sent again. This prevents duplicate deliveries when multiple subscriptions
overlap.

```typescript
// Server-side per-session tracking
interface SessionState {
  // Last version sent for each entity (keyed by entityId)
  lastRevision: Map<EntityId, number>;
}
```

### 4.6.3 Classified Content

Facts with classification labels may be redacted before delivery. If a
subscriber lacks the appropriate claims for a classification level, the
server omits the `value` field from the fact (delivering the metadata —
entity ID, version, parent — without the content).

---

## 4.7 Error Responses

All errors are returned as `{ error: E }` objects in the `task/return`
receipt. Each error type has a specific name and payload.

```typescript
// Transaction was rejected due to stale reads
interface ConflictError extends Error {
  name: "ConflictError";
  commit: ClientCommit;
  conflicts: ConflictDetail[];
}

// Transaction failed due to a server-side error (e.g., storage failure)
interface TransactionError extends Error {
  name: "TransactionError";
  cause: SystemError;
  transaction: ClientCommit;
}

// Query failed
interface QueryError extends Error {
  name: "QueryError";
  cause: SystemError;
  space: SpaceId;
  selector: Selector | SchemaSelector;
}

// Caller lacks authorization
interface AuthorizationError extends Error {
  name: "AuthorizationError";
}

// Network or transport failure
interface ConnectionError extends Error {
  name: "ConnectionError";
  cause: SystemError;
  address: string;
}

// Rate limit exceeded
interface RateLimitError extends Error {
  name: "RateLimitError";
  retryAfter: number;  // Seconds until the client can retry
}

// Underlying system error
interface SystemError extends Error {
  code: number;
}
```

---

## 4.8 Client Library API

The client library provides a typed TypeScript interface over the wire protocol.
It manages the WebSocket connection, UCAN signing, pending state, and
subscription lifecycle.

### 4.8.1 Connection

```typescript
import { connect } from "@commontools/memory";

// Establish a connection to the memory server
const session = connect({
  url: new URL("ws://localhost:8001"),
  as: signer,           // Signer with the client's private key
  clock?: Clock,         // Optional clock for timestamp generation
  ttl?: number,          // Optional TTL for invocations (seconds)
});
```

The `connect` function opens a WebSocket, sets up the bidirectional message
stream, and returns a `MemorySession`.

### 4.8.2 Space Session

A session is scoped to a specific space by calling `mount`:

```typescript
const space = session.mount("did:key:z6Mk...");
```

This returns a `SpaceSession` with methods for reading and writing:

```typescript
interface SpaceSession {
  // Submit a transaction (args is a ClientCommit — see §3.4)
  transact(args: {
    reads: {
      confirmed: ConfirmedRead[];
      pending: PendingRead[];
    };
    operations: Operation[];
    codeCID?: Reference;
    branch?: BranchId;
  }): Promise<Result<Commit, ConflictError | TransactionError>>;

  // Query entities
  query(args: {
    select: Selector;
    since?: number;
    branch?: BranchId;
  }): Promise<Result<QueryView, QueryError>>;

  // Schema-driven query with optional subscription
  queryGraph(args: {
    selectSchema: SchemaSelector;
    since?: number;
    subscribe?: boolean;
    excludeSent?: boolean;
    branch?: BranchId;
  }): Promise<Result<QueryView, QueryError>>;
}
```

### 4.8.3 Query View

The result of a query is a `QueryView` — a live, updateable view of the
query results.

```typescript
interface QueryView {
  // Current facts matching the query
  facts: StoredFact[];

  // Subscribe to live updates
  subscribe(): Subscription;

  // The underlying selection data
  selection: FactSet;
}

interface Subscription {
  // Async iterator of updates
  [Symbol.asyncIterator](): AsyncIterator<SubscriptionUpdate>;

  // Close the subscription
  close(): Promise<void>;
}
```

Usage:

```typescript
const result = await space.query({
  select: { "urn:entity:abc": {} }
});

if (result.ok) {
  const view = result.ok;

  // Read current values
  for (const fact of view.facts) {
    console.log(fact.id, fact.value);
  }

  // Subscribe to changes
  const subscription = view.subscribe();
  for await (const update of subscription) {
    console.log("Changed:", update.revisions);
  }
}
```

### 4.8.4 Session Lifecycle

```typescript
// Close the session and all active subscriptions
session.close();
```

Closing a session:
1. Cancels all pending invocations (rejects their promises)
2. Closes all active subscriptions
3. Closes the WebSocket connection

---

## 4.9 Blob Transfer

Blobs (content-addressed immutable data) are transferred via **separate HTTP
endpoints**, not inline in WebSocket messages. This avoids bloating the
message stream with large binary payloads.

### 4.9.1 Upload

```
PUT /blob/<hash>
Content-Type: <mime-type>
Authorization: Bearer <ucan-token>

<raw bytes>
```

The client computes the content hash locally and includes it in the URL. The
server verifies the hash matches the uploaded content. If the blob already
exists (by hash), the upload is a no-op (idempotent).

**Response:**

| Code | Meaning |
|------|---------|
| 201  | Created (new blob stored) |
| 200  | Already exists (no-op) |
| 400  | Hash mismatch |
| 413  | Payload too large |

### 4.9.2 Download

```
GET /blob/<hash>
Authorization: Bearer <ucan-token>
```

**Response:**

| Code | Meaning |
|------|---------|
| 200  | Success, body contains blob bytes |
| 404  | Blob not found |
| 403  | Access denied |

The `Content-Type` header in the response reflects the blob's MIME type.

### 4.9.3 Referencing Blobs from Entities

Entities reference blobs via their content hash. The blob hash is stored as a
regular JSON value in the entity's fact:

```typescript
// Entity referencing a blob
const fact = {
  id: "urn:entity:document:1",
  value: {
    title: "My Document",
    attachment: { "/": "baedrei...blobhash" }  // Content-addressed reference
  },
  parent: previousHash,
};
```

The client library resolves blob references on demand — the blob data is
fetched separately when the application needs it.

---

## 4.10 Branch Parameter

All commands accept an optional `branch` parameter. When omitted, the command
targets the default branch.

```typescript
// Read from a branch
await space.query({
  select: mySelector,
  branch: "draft",
});

// Write to a branch
await space.transact({
  reads: { confirmed: [...], pending: [] },
  operations: [...],
  branch: "draft",
});

// Subscribe to changes on a branch
await space.queryGraph({
  selectSchema: mySchema,
  subscribe: true,
  branch: "draft",
});
```

Branch lifecycle commands (creation, merging, deletion) are defined in §4.3.6.
Full branching semantics are covered in section 6 (Branching).

---

## 4.11 Message Ordering

### 4.11.1 Client-Side Ordering

The client library guarantees that messages are sent in the order they are
submitted, even though UCAN authorization (signing) is asynchronous. A send
queue ensures that authorization for message N does not cause message N+1 to
be sent out of order:

```
Submit C1 → [authorize C1] → Send C1
Submit C2 → [authorize C2] → wait for C1 to send → Send C2
Submit C3 → [authorize C3] → wait for C2 to send → Send C3
```

### 4.11.2 Server-Side Ordering

The server processes transactions serially within a branch (or with equivalent
serializable isolation). Responses are sent in the order transactions are
processed. Subscription updates are sent after the producing transaction's
response.

---

## 4.12 Mapping from Current Implementation

| v1 Concept | v2 Concept | Notes |
|------------|------------|-------|
| `ConsumerSession` (TransformStream) | `connect()` → `MemorySession` | Same architecture, cleaner API |
| `MemorySpaceConsumerSession` | `SpaceSession` (via `mount`) | Same pattern |
| `Protocol` type (complex mapped type) | Simplified command types | Explicit per-command types instead of type-level metaprogramming |
| `Changes` (nested `of/the/cause`) | `Operation[]` (flat list) | Matches commit model simplification |
| HTTP `PATCH /` | HTTP `PATCH /` | Unchanged |
| HTTP `POST /` | HTTP `POST /` | Unchanged |
| Blob transfer | `PUT/GET /blob/<hash>` | New in v2 |
| `ProviderSession` (TransformStream) | Same architecture | Bidirectional stream piping |

---

Prev: [03-commit-model.md](./03-commit-model.md)
Next: [05-queries.md](./05-queries.md)
