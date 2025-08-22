# Storage Client Library (WS v2) — Spec

This document specifies a client-side library that talks to the new storage
backend over WS v2, maintains a local store of Automerge documents, exposes a
transactional API, and delivers change notifications to a scheduler component.

Status: proposal. Targets the WS v2 protocol defined in
`packages/storage/src/ws/protocol.ts` and exercised in
`packages/storage/integration/ws_v2*.test.ts`.

## Goals

- Manage one WebSocket per space (`/api/storage/new/v2/:space/ws`), with
  epoch-based resume (via `/storage/hello`) and at-least-once delivery
  semantics.
- Maintain a client-side store of Automerge documents per space with a composed
  view: last server-confirmed state plus locally pending transactions.
- Expose a high-level API to read/subscribe by `{ space, docId, path, schema }`
  and to open transactions with read/write/commit/abort primitives.
- Provide conservative, deterministic client-side transaction validation
  (read-set tracking) and rejection cascade on conflicts.
- Surface a scheduler callback API that receives before/after JSON for any
  effective change in the composed view.

Non-goals (initial):

- Cross-space write transactions (reads may cross spaces; writes are constrained
  to a single space per tx).
- Offline persistence and multi-tab coordination.
- Full UCAN invocation/signature management beyond passing an optional
  Authorization token.

## Terminology and Model

- Server head/state: the last server-confirmed version per document (epoch,
  heads). This updates on `Deliver` + `Ack`, and on `TaskReturn` for tx.
- Pending change: a local change (from a client transaction) not yet confirmed
  by the server.
- Composed view: Automerge state derived by applying all pending changes (in tx
  order) on top of the last server head; this is what reads and scheduler
  callbacks observe.
- Read-set: set of `(space, docId, pathKey)` observed by a transaction while
  reading; used to invalidate on external modifications.
- Tx dependency: if Tx B read a value that includes pending writes from Tx A, B
  depends on A and must be rejected if A is rejected.

## Wire protocol mapping

The library uses the WS v2 protocol (types in `src/ws/protocol.ts`).

- Open: `WebSocket` to `/api/storage/new/v2/:space/ws`.
- Resume: send `/storage/hello` with `{ clientId, sinceEpoch }` before first
  command on reconnect.
- `get` and `subscribe`: send invocation `/storage/get` or `/storage/subscribe`
  with `GetArgs { consumerId, query? }`, where `query` can specify
  `{ docId, path, schema }`.
- Delivery: handle `Deliver { epoch, docs[] }` frames. Docs are base64 Automerge
  bytes (`snapshot`) or arrays of base64 change bytes (`delta`). Always `ack` by
  `epoch`.
- Completion: `TaskReturn { is: { type: "complete" } }` signals completion of
  the initial backfill for the corresponding request.
- Transactions: send `/storage/tx` with `WSTxRequest`. Each write contains
  `ref { docId, branch }`, `baseHeads`, and an array of `{ bytes }` (base64
  encoded). For write-only txs, set `allowServerMerge: true`.

## Public API (TypeScript)

Namespace: `@commontools/storage/client` (implementation under
`packages/storage/src/client/*`).

### StorageClient

- constructor(opts)
  - `baseUrl?: string` — default `window.location.origin` or caller-provided
  - `token?: string | () => Promise<string>` — optional Authorization header for
    WS upgrade (if server gated) or for per-message auth if required in the
    future
  - `logLevel?: "off"|"error"|"warn"|"info"|"debug"`
- `connect(space: string): Promise<void>` — opens/reuses a socket for the space;
  handles `/storage/hello` with last acknowledged epoch for resume.
- `disconnect(space: string): Promise<void>` — closes socket; keeps in-memory
  store until GC.
- `get(options: { space: string; docId: string; path?: string[]; schema?: unknown }): Promise<{ json: unknown; version: { epoch: number; branch?: string } }>`
  — one-shot backfill using `/storage/get`; resolves after `complete`.
- `subscribe(options: { space: string; consumerId: string; query: { docId: string; path?: string[]; schema?: unknown } }): Promise<() => void>`
  — begins a live subscription and returns a promise that resolves once the
  initial backfill has completed (i.e., a subsequent `readView`/`read` observes
  the delivered state). The promise resolves to an `unsubscribe` function.
- `newTransaction(): Transaction` — creates a transaction bound to this client.
- `registerScheduler(cb: (ev: { space: string; docId: string; path: string[]; before: unknown; after: unknown }) => void): () => void`
  — register a scheduler callback; invoked on any effective change in the
  composed view.
- `readView(space: string, docId: string): { json: unknown; version: { epoch: number } }`
  — returns the composed view and the current last-ack server epoch; reads do
  not trigger network.
- `synced(): Promise<void>` — resolves when, at the time of the call, all
  pending commits have been accepted/rejected and all active subscriptions have
  delivered their initial backfill (`complete`). Subsequent changes may arrive
  after the promise resolves.

Notes:

- The client maintains a per-space `clientId` and an `ackEpoch` map (updated on
  `ack`).
- `subscribe` calls always send an `ack` per `Deliver.epoch`.

### Transaction

Transactions can read across spaces but may only write to a single space. The
effective view for reads includes all pending local transactions plus this
transaction's own uncommitted writes.

Properties/methods:

- `read(space, docId, path, nolog = false, validPathOut?: string[]): unknown`
  - Returns the value at `path` in the composed view (server head + all pending
    including this tx). If a subpath is invalid, returns `undefined`. If
    `validPathOut` is provided, it is filled with the longest existing prefix.
  - Records a read log entry unless `nolog` is true.
- `write(space, docId, path, mutate, validPathOut?: string[]): boolean`
  - Applies a change rooted at `path` by invoking `mutate(subProxy)` inside an
    Automerge change. Returns true if the `path` existed; false otherwise (and
    no write recorded).
  - On the first write, the transaction becomes bound to that `space`;
    subsequent writes must target the same space or throw.
- `commit(): Promise<{ status: "ok"|"conflict"|"rejected"; receipt?: import("../types.ts").TxReceipt }>`
  - If no writes occurred, returns `{ status: "ok" }` without contacting the
    server and without allocating a tx id.
  - If only writes occurred (no reads logged), sets `allowServerMerge = true` on
    all writes.
  - Sends `/storage/tx`. On `ok`, server heads advance; pending changes for this
    tx are removed from the pending chain, and composed view remains on newest
    pending if any. On `conflict|rejected`, all writes from this tx are rolled
    back from the pending chain, server head reverts to last known good, and
    dependent transactions are rejected.
  - New document creation: if a document does not exist yet in the client store
    (no server head), initialize a genesis base using
    `createGenesisDoc(docId, actor?)` from `src/store/genesis.ts` and use
    `Automerge.getHeads(genesis)` as `baseHeads` for the first write. This
    ensures consistent initial identity (`computeGenesisHead`) and actor/seq
    monotonicity.
- `abort(): void` — marks the tx aborted; further reads/writes throw; removes
  staged writes from the pending chain.
- `log: Array<{ space: string; docId: string; path: string[]; op: "read"|"write" }>`
  — ordered read/write log without values.

Validation and rejection:

- Read-set tracking: the tx records every `(space, docId, pathKey)` it read
  (pathKey = JSON.stringify(path)). If any of these docs (conservative: any path
  in the doc) change due to another tx or a server deliver before commit
  completes, the tx is immediately rejected and throws on further operations.
- Tx dependencies: if a tx reads a doc version that includes pending writes from
  another tx, it depends on that tx; if the depended-upon tx is rejected, reject
  this tx as well (cascade).

### Scheduler notifications

The client emits a scheduler event for every effective change to the composed
view (incoming delivery, local staged write, tx commit/abort/reject). The
callback receives:

```ts
{
  space, docId, path, before, after;
}
```

`before`/`after` are values as returned by `Transaction.read()` for the same
`path` (composed view at t-1 and t).

Path selection: For performance, the client computes impacted path keys from the
change (array of changed JSON paths) and emits callbacks for those keys. A
coarse mode (emit `[]` root only) is acceptable initially.

## Client-side storage model

Per space, per doc:

- `server: { epoch: number; heads: string[]; branch: string = "main"; baseBytes: Uint8Array; baseDoc: Automerge.Doc<any> }`
  — last confirmed state (reconstructed from bytes on demand).
- `pending: Array<{ txId: string; createdAt: number; changes: Uint8Array[]; actor?: string }>`
  — strictly ordered by creation; applied to derive `composed`.
- `composed: Automerge.Doc<any>` — cached doc derived by applying `pending` to
  `server.baseDoc`. Recomputed incrementally.

On `Deliver`:

- For each doc in `docs[]`:
  - If `snapshot`: replace `server.baseBytes` and `server.baseDoc` with decoded
    bytes; update `server.epoch` and `heads`.
  - If `delta`: apply changes to `server.baseDoc` (and bytes) and update
    `server.epoch`/`heads`.
  - Recompose `composed` by re-applying `pending` in order. Remove any pending
    entries that are now reflected in `server.heads` (match by change hash if
    available) when we receive tx receipts that include `newHeads`.
  - Emit scheduler events for affected docs/paths with before/after JSON.
  - Immediately `ack` the epoch.

On local writes (staged in a tx):

- Do not send to the network until `commit()`; however, the staged writes are
  visible in the composed view of this tx and (optionally) globally visible in
  the client store pending chain to support read-your-writes across components.

On `TaskReturn` for `/storage/tx`:

- If status `ok`, record receipt and advance `server.epoch`/`heads`. Remove
  staged writes for this tx from `pending`.
- If status `conflict|rejected`, roll back staged writes (remove from
  `pending`), reset composed to previous, and trigger cascade rejection.

## Concurrency and conflicts

Initial policy (conservative):

- Doc-level invalidation: if a tx read from `(space, docId, *)` and any other
  source (deliver or different tx) modifies that doc prior to commit, reject
  immediately.
- Optional refinement: track path keys from reads and compare to changed set to
  allow narrower invalidation.

Server conflicts are final: if the server rejects/marks conflict for a tx, the
client treats it as rejected and applies the rollback/cascade logic.

## Error handling and retries

- WS reconnect with exponential backoff (jitter). On reconnect, send
  `/storage/hello { clientId, sinceEpoch: lastAck }` to resume.
- If resume is stale, the server may backfill with a snapshot or deltas; handle
  both.
- Network errors during `commit()` result in retrying the invocation on
  reconnection unless the tx was aborted by the caller.

## Security

- If `WS_V2_REQUIRE_AUTH` is enabled on the server, the client should set an
  `Authorization: Bearer <token>` header on WS upgrade. The library accepts a
  `token` or `token provider` in the constructor. The same token is used until
  refreshed by the provider.

## Performance notes

- Avoid unnecessary `Automerge.toJS()` on large docs; for scheduler events,
  compute subtrees only for impacted paths.
- Maintain incremental `composed` by applying staged changes rather than
  reapplying from scratch.

## Testing plan

- Unit tests:
  - Path navigation (`validPathOut`) and read/write behavior at subpaths.
  - Pending chain composition, staged write visibility, and rollback on reject.
  - Read-set invalidation (doc-level) and cascade rejection.
  - Tx write-only vs read-write (server merge flag behavior).
- Integration tests (mirroring `ws_v2*.test.ts`):
  - Subscribe, deliver, and ack; resume with hello (exact and stale epochs).
  - Get-only completes with no subsequent delivers.
  - Tx happy path: commit ok and receipt mapping; conflict path: rollback and
    cascade.

## Acceptance criteria

- API and behavior match this spec; types are explicit and safe (no `any`).
- Works against the dev server in `packages/storage/deno.ts`.
- Unit + integration tests pass under `deno task test` for `packages/storage`.
