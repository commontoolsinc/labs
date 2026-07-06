# Server-Primary Execution

Status: design exercise — approaches explored, decision pending. Author:
design session 2026-07-06; revised same day after review (dual handler
execution as the event end-state, scoped derivation on the executor as the
end-state, state-residency §6.7). No implementation in this spec.

Related specs: `docs/specs/scheduler-v2/`,
`docs/specs/persistent-scheduler-state.md`, `docs/specs/pull-based-scheduler/`,
`docs/specs/content-addressed-action-identity.md`,
`docs/specs/pattern-id-retirement.md`, `docs/specs/memory-v2/`,
`docs/specs/toolshed-access-control.md`, `docs/specs/cfc-write-prefix-provenance.md`.
Related in-flight PRs: #4288 (scheduler-v2 cutover), #4514 / #4298 (reactive
interpreter v2/v1), #4427 (event parking), #4495 (conflict catch-up), #4139
(seq-token draft), #4115 (closeSpace), #2659 (per-space LLM throttling).

---

## 1. Summary

Today the memory server is central but passive: every client runs the full
reactive graph of every open piece, and clients race each other — N clients
means N redundant executions of the same computations, write-write conflicts
on shared derived state, async work (fetch, LLM) that dies with a closed tab,
and a per-session subscription machinery whose cost is
O(commits × sessions × graph-query re-evaluation) on the server.

This document designs the inversion: **the server becomes the primary
executor**. Clients send only the updates that originate from user intent
(typically UI events), speculatively execute derived data locally for
latency, and never push derived results. The server — co-located with the
SQLite store — keeps every "running" piece current, performs all async work,
and feeds clients changes. A third motivation joins races and cost: **trust
asymmetry** — the server is more trustworthy than any client, so
executor-computed results are the basis for downstream integrity guarantees
about derived data (§5.B.7), which client-computed results can never
honestly provide.

Four approaches are explored in depth:

- **A — Server catch-up executor**: generalize `background-piece-service`
  into an always-on space executor; clients unchanged. Low risk, kills async
  fragility, does *not* kill races.
- **B — Derived-authority split** (the proposed model): clients commit only
  event-driven (source) writes; the server is the sole writer of derived
  data and the sole async executor; clients speculate derived state locally
  as a never-committed overlay.
- **C — Event shipping**: clients ship signed event envelopes; the server
  runs handlers too, authoritatively, while clients keep running them
  speculatively. Total per-space serialization; largest protocol and
  identity lift; adopted as the end-state for events.
- **D — Thin projector**: no client execution at all; the server computes
  everything including VNode docs; clients materialize DOM.

**Recommendation: land A as the enabling milestone, then B as the target
model, evolving events to dual execution — the handler runs on the server
authoritatively and on the client speculatively (C's machinery) — as the
end-state.** B matches the product need (races on derived data disappear structurally;
async is reliable; clients keep instant local feedback), reuses today's
commit/conflict machinery for the remaining genuine contention on source
writes, and can fall back to today's behavior per space via a flag. D is not
a distinct migration target but where B trends as RI + VNode-doc
consolidation land: clients that *choose* not to speculate get a working,
slightly-laggier UI for free.

The load-bearing enablers are exactly the in-flight work: persistent
scheduler state (cheap spin-up/down of per-piece graphs), scheduler v2
(bounded settle, static write surfaces, read-delta bookkeeping), source
linking via the `source`/`pattern` doc annotations + content-addressed
action identity (stale doc → producing piece → runnable action), and the
reactive interpreter (execution density on the server). §9 is a register of the gaps that remain even after all of those
land — the two largest are **executor authority/identity** (§9 G1–G3) and
**the derived/source write split in the runner** (§9 G5).

---

## 2. Today's topology and what it costs

### 2.1 Execution: N clients × same graph

Each browser tab boots one runtime per (identity, apiUrl) in a web worker
(`packages/shell/src/lib/runtime-lifecycle.ts:8`,
`packages/lib-shell/src/runtime.ts:527`). The space root pattern is the
canonical demand root (`packages/lib-shell/src/runtime.ts:240`); navigated
pieces start on demand (`getPattern(space, id, { start: true })`). Every
client runs the *entire* reactive graph of every started piece: computations,
materializers, render effects, and async builtins.

Consequences, all previously measured:

- **Redundant compute.** Two tabs on the same space run every lift/computed
  twice. The multi-user perf baseline records ~+19% action volume from a
  second participant on group-chat-scale patterns even after coalescing
  work; the pre-#4237 lunch-poll write-write ping-pong was the same shape at
  its worst.
- **Races on derived data.** Both runtimes write the same derived docs.
  Conflicts are cheap now (seenSeq-gated refresh, commit `5abe477c7`), but
  they still ratchet under multi-browser load and burn retries; the
  cross-tab mutex machinery inside async builtins
  (`packages/runner/src/builtins/fetch-utils.ts:90`) exists only to paper
  over exactly this.
- **Async fragility.** fetch/LLM calls run in whichever tab claimed the cell
  mutex; a closed tab aborts the request
  (`packages/runner/src/builtins/fetch.ts:312`) and someone else may re-claim
  after a 5s–5min timeout. Streaming LLM partials live in an in-memory
  `partial` cell and are lost on disconnect.
- **Cold start.** A fresh client cannot paint pattern UI until it compiles
  and executes patterns locally (browser cold-compile floor ≈ 525ms for the
  entry-file emit alone, plus dependency collection and first settle).

### 2.2 Subscriptions: per-session graph re-evaluation

The wire is a WebSocket session (`session.open` with a signed challenge;
per-space ACL `OWNER/WRITE/READ`). Clients register *graph queries* via
`session.watch.set`. On every commit the server marks the space dirty and,
after `SUBSCRIPTION_REFRESH_DELAY_MS = 5` (`packages/memory/v2/server.ts:92`),
walks all connections × sessions whose watch is affected and **re-runs each
session's graph query** against live state
(`refreshTrackedGraph`, `packages/memory/v2/server.ts:2223`). There is no
query-result caching; cost is O(dirty commits × affected sessions ×
graph-traversal). This is the cost the redesign wants to remove — and it is
also *duplicated* state: the query describes the client's dependency
closure, which the client's own scheduler already knows, and which a
server-side executor would know natively.

### 2.3 What already points the right way

- The client write path is already optimistic: handler transactions apply
  locally before the server confirms; conflicts retry with a budget
  (`packages/runner/src/scheduler/events.ts:715`). "Speculate locally,
  confirm remotely" is the existing model — it just applies to *all* writes
  instead of only source writes.
- The commit protocol already carries read provenance
  (`ClientCommit.reads.confirmed = (id, path, seq)` and
  `pending = (id, path, localSeq)`), and replays are idempotent by
  `(sessionId, localSeq)` (`docs/specs/memory-v2/03-commit-model.md` §3.6).
- `background-piece-service` already runs a runtime per space in a **Deno
  Worker thread** (`packages/background-piece-service/src/worker-controller.ts:78`),
  discovered reactively from a registry cell, under a single service
  identity. It is the seed of the executor pool (§6), currently limited to
  a ~60s polling updater and websocket transport back to the same host.
- Server-initiated writes into spaces exist and pass CFC: webhook ingest
  (`POST /api/ingest/:id` with `externalIngestStamp`) and the sqlite
  builtin's server-executed query + result writeback.
- The store is fast and co-locatable: reads are synchronous FFI (~2µs;
  JSON decode dominates for large docs), and an in-process transport exists
  (`loopback`, `packages/memory/v2/client.ts:1299`;
  `StorageManager.emulate()`, `packages/runner/src/storage/v2-emulate.ts:36`).

---

## 3. Foundations assumed to land (and what each contributes)

This design assumes the following in-flight work lands. Each subsection
notes residual gaps *within* that line; the consolidated register is §9.

### 3.1 Scheduler v2 (#4288, phases 3c–7)

Already on main: durable event IDs (#4088), speculation lineage (#4090),
static write surfaces (#4098), tx-carried source action for
self-suppression (#4099), node records + liveness refcounts (#4101/#4102).
In flight: gates unification, declared-reads (no dependency-collection
prefetch), bounded settle (`PASS_RUN_BUDGET = 5`).

Contribution: a scheduler whose per-node state is one record
(status/liveRefs/reads/writes), whose demand is refcounted rather than
walked, and whose settle loop is bounded — i.e., a graph that can be
suspended, described, and resumed. That is precisely the shape a server
executor must hold for hundreds of spaces.

### 3.2 Persistent scheduler state (spec + partial implementation)

On main: the observation snapshot
(`SchedulerActionObservation` — `ownerSpace`, `branch`, `pieceId`,
`actionId`, `actionKind`, `implementationFingerprint`, `observedAtSeq`,
`reads`, `currentKnownWrites`, `declaredWrites`, gate options, status —
`packages/runner/src/scheduler/persistent-observation.ts:22`), the
rehydration entry points (`rehydrateActionFromStorage`,
`packages/runner/src/scheduler.ts:666`), and the storage-provider seam
(`listSchedulerActionSnapshots`,
`packages/runner/src/storage/interface.ts:271`).

Missing (G4): the memory-side tables (`scheduler_observation`, read/write
indexes, action state) wired into the commit pipeline; durable dirty
markers (compare `observedAtSeq` against branch-head seq); and the
**doc → readers index** derived from the persisted read sets, which is
what lets the server answer *"commit touched doc X; which parked pieces
have stale downstream state?"* without instantiating anything. The
*producer* direction, by contrast, needs no index at all: it is already
recorded on the docs themselves as the `source`/`pattern` annotation chain
(§3.3).

Contribution: spin-up/spin-down becomes cheap. An idle space's graph is a
set of observation rows; waking it is `rehydrate` + running only actions
whose inputs moved past their `observedAtSeq`. `observedAtSeq` doubles as
the **derived-data watermark** the reconciliation protocol needs (§5.B.4).

### 3.3 Source linking (landed on main, small gaps)

Result cells carry `patternIdentity = {identity, symbol}`
(`packages/runner/src/runner.ts:1014`); serialized modules/handlers carry
`$implRef` / `$patternRef` sentinels; verified provenance is a WeakMap keyed
by the function object; `pattern:<identity>` source docs form a
Merkle-verified closure with `loadPatternByIdentity` +
`compileCache:<runtimeVersion>/<identity>` for cold recovery (single-flighted,
#4460). Action identity is per-instance
(`cf:module/<hash>:<symbol>:<instanceKey>`,
`docs/specs/action-id-per-instance-decision.md`), reload-stable.

Contribution: **doc → producing piece is recorded on the docs themselves.**
Every document envelope carries provenance annotations
(`docs/specs/memory-v2/01-data-model.md`): a `source` short-link to the doc
it derives from, and — on a piece's root docs — the well-known `pattern` /
`argument` / `result` / `internal` metadata links
(`packages/runner/src/result-utils.ts:17` writes `pattern`; the raw
`["source"]` surface is runtime metadata, excluded from CFC flow reads,
`packages/runner/src/cfc/prepare.ts:1159`). The reverse lookup is
therefore a walk, not an index: **follow `source` until a doc carries
`pattern`** — that doc is the piece root, and `pattern` +
`patternIdentity` name the runnable module. The full catch-up path:

```
stale doc ──(follow `source` links)──▶ piece root doc carrying `pattern`
`pattern` / `patternIdentity` ───────▶ {identity, symbol}
identity  ──(loadPatternByIdentity)──▶ compiled closure (or recompile
                                        from source docs)
`argument` meta link ──▶ argument cell ──▶ re-instantiate ──▶ rehydrate
observations (per-instance actionId) ──▶ pull the stale doc
```

The walk runs directly against the store (state-inspector-style), with
zero scheduler state; the persisted observations then narrow *which*
actions inside the piece are stale (`observedAtSeq` vs branch head)
instead of re-settling the whole piece.

Gaps: keyless/hand-built patterns are session-only by design (no durable
pointer — sanctioned); the chain needs a coverage audit — every doc the
executor may be asked to catch up must terminate the `source` walk at a
`pattern`-bearing root (builtin-created docs, schema-less writes, and
external ingest are the suspect cases, G6); `.src` eager annotation is
dev-only but debug-only (no identity impact).

### 3.4 Reactive interpreter (#4514; v2 supersedes #4298; nothing on main)

One trusted interpreter node per pattern (`kind: "builtin"`) over a
serializable, content-addressed ROG; leaf closures still run in SES; Tier
1–2 expression lowering interprets simple functions natively. Measured on
the RI branch: rendered-list docs/element 3→1ish (notes-list docs/note
5→2, nodes 5→3), overall docs −34%, 88.4% op engagement, 123/173 corpus
patterns fully interpretable. v2 emits the ROG as a compiled artifact —
i.e., a piece's dataflow becomes *data* the server can load without
executing pattern module code.

Contribution to this design: **density and spin-up cost**. Without RI a
server executor is browser-parity: per-piece SES sandboxes and 5+3N docs
per collection. With RI, interior dataflow is pure in-memory evaluation and
only externally-reachable cells become docs.

Caveats that matter here (G8): the cross-space pull-amplification loop
(~226–270× re-sync on reader-isolated cross-space docs) and the F4 I/O
coalescing conflict ratchet both currently gate RI default-on; **scoped
(PerUser/PerSession) outputs are excluded from interpretation today** —
tolerable during the transitional carve-out (§5.B.6) but a real gap for the
end-state, where scoped derivation runs on the executor precisely because
its integrity matters most (G16). RI is an *optimizer* for the executor, not a
prerequisite: every approach below works with the compiled path first.

### 3.5 Deliberately not assumed

- Memory-v2 branching (`docs/specs/memory-v2/06-branching.md`) — useful for
  speculation (§5.B.4 option ii) but the recommended design does not
  require it.
- Verifiable execution / receipts (`docs/specs/verifiable-execution/`) —
  the long-term frame for "who computed this and can we check it", but this
  design only needs its cheapest primitive (signed request proofs, already
  precedented by `toolshed-access-control.md`).

---

## 4. The four design questions

Every approach is an answer to these four questions; naming them keeps the
approach comparison honest.

- **Q1 — Authority: which writes may a client commit?**
  All writes (today) / source writes only (B) / no writes, events only (C).
  "Source write" is definable *today* by the originating action kind the
  scheduler already stamps on transactions (`tx.sourceNodeId` → node kind:
  `event-handler` vs `computation`/materializer-effect), plus
  setup/seed-materialization structural writes, plus direct `.set()` from
  UI bindings — everything else is derived.
- **Q2 — Reads: how do clients learn about remote changes?**
  Per-session graph-query re-evaluation (today) / doc-granular delta feed
  filtered by a server-maintained interest closure (§6.4) / whole-space
  feed for small spaces.
- **Q3 — Speculation: what does the client compute locally, and how is it
  reconciled?** Nothing (A, D) / derived overlay reconciled by watermark
  (B) / handlers + derived, reconciled by event acks (C).
- **Q4 — Executor placement and isolation:** none (status quo) / worker
  thread per space co-located with the memory engine (§6.1) / subprocess
  tier for untrusted or heavy spaces (§6.6).

---

## 5. Approaches

### Approach A — Server catch-up executor (generalized background-piece-service)

**Model.** Keep client behavior exactly as today. Promote
`background-piece-service` into an executor pool (§6) that keeps *every*
space with registered interest current — reactively, not on a 60s poll —
and owns async builtins for spaces it runs. Clients still execute
everything and still commit derived writes; the server is one more
(privileged, always-on) participant whose job is to catch up spaces nobody
has open and to complete async work that clients abandon.

**What changes.**

1. bps's `SpaceManager` workers switch from websocket-to-self to the
   in-process transport (§6.2) and from polling `bgUpdater` streams to
   standing demand roots per registered piece.
2. Async builtins gain an executor-priority rule: the server executor's
   claim on the existing request-mutex cells
   (`packages/runner/src/builtins/fetch-utils.ts:90`) always wins; client
   claims are only taken when no executor is registered for the space.
   (Cheap: raise the executor's claim precedence and shorten its heartbeat.)
3. Piece registration generalizes from the BG registry cell to "any piece
   in a space with executor service enabled" (§6.3 interest sets).

**Identity/CFC.** Unchanged for clients. The executor runs under a service
identity that space owners grant WRITE (the existing bps model). Derived
writes it produces carry the same verified implementation identities as
client-produced ones (it runs the same modules), so `writeAuthorizedBy`
gates pass identically. No event envelope needed because it never runs
user-intent handlers — it only reacts to committed state.

**Failure modes.** Server executor down → exactly today's system. Client
and executor race on derived writes → conflicts, as today, except the
executor adds one more writer (slightly *more* contention). The mutex
priority rule keeps async single-fire in the common case.

**Perf.** No client-side win. Server cost: one runtime per active space.
Subscription serving cost unchanged.

**Verdict.** Not the destination — it does not remove races or client
execution cost, and adds a writer. But it is the right **first milestone**:
it builds the executor pool, the in-process transport, the interest
registry, executor identity/grants, and async ownership — every piece of
§6 — while being trivially revertible (turn the service off). It also
immediately fixes the worst user-visible fragility (abandoned async work,
cold spaces with pending timers/imports).

---

### Approach B — Derived-authority split (proposed)

**Model.** Writes are partitioned by origin:

| Write class                                   | Authority        | Sync behavior |
| --------------------------------------------- | ---------------- | ------------- |
| Event-handler writes (user intent)            | client commits   | as today: optimistic local apply + commit + conflict retry |
| Setup / seed-materialization structural writes | client commits   | part of the creating action's tx, as today |
| Direct UI-binding writes (`$value` etc.)      | client commits   | they are user intent |
| Computation / materializer (derived) writes   | **server only**  | client computes them into a local, never-committed overlay |
| Async builtin request/result writes           | **server only**  | client renders `pending` state; server writes results |
| PerSession / PerUser-scoped derived writes    | client commits (transitional) | executor-computed in a later phase, see B.6 |

The server executor (§6) is the sole committer of space-scoped derived
data. Clients keep running the derived graph *locally* for latency, but
those writes terminate in an overlay: visible to the local UI and to local
computations downstream, never shipped, always discardable.

#### B.1 Client write path

The runner tags every transaction with its originating node
(`tx.sourceNodeId`, landed with #4099) and the node kind is known at
subscribe time. The storage layer routes on it:

- `event-handler` (and setup/seed) transactions → today's commit pipeline.
- `computation`/materializer transactions → **overlay apply**: applied to
  the local `ISpaceReplica` in a speculative layer keyed by
  `(baseSeq, generation)`, never enqueued for upstream commit.

This is G5, the single biggest runner change in B, and it is smaller than
it looks: the local-apply half already exists (optimistic apply precedes
confirmation today); what is new is (a) the routing decision, (b) an
overlay layer in the replica that can be dropped wholesale, (c) read
layering (overlay > confirmed) for UI reads.

#### B.2 Server write path

The executor runs the same graph with the same scheduler; its
computation/materializer transactions commit through the in-process engine
(§6.2) under the executor identity. Every derived commit is stamped with a
**derived-from watermark**: the max input `seq` consumed by the producing
action — which is exactly `observedAtSeq` from the persistent-observation
work, surfaced onto the commit (G4/G10).

#### B.3 Handler reads: today's semantics, then dual execution

Handlers keep today's optimistic semantics, which are already correct for
this model: a handler runs against the client's local state; if that state
was outdated, the commit fails conflict detection, and the client retries
once caught up, then succeeds. Nothing new is built for B here — the
existing conflict/retry machinery
(`packages/runner/src/scheduler/events.ts`, retry budget + `readyToRetry`)
*is* the speculation guard.

One residual window is accepted knowingly: a handler may read an
overlay-derived value the server has not computed yet (a prediction), and
its source write can be admitted before the server's recompute lands —
conflict detection can only compare against *committed* state. This is the
same class of optimistic bet the system already makes; it self-heals (the
server's recompute overwrites, downstream re-settles) and is counted, not
prevented.

The end-state closes the window structurally: **the event ships to the
server and the handler runs on both sides** — the server's run is
authoritative (it reads authoritative derived state by construction), the
client's run is the speculative part, reconciled by the event's durable ID
(#4088) and its ack. That is approach C's machinery (§5.C), adopted as the
target for events rather than an escape hatch; B is the intermediate state
in which only the handler's *writes* ship, not the event itself.

#### B.4 Reconciliation protocol

Client state per doc: `confirmed(seq)` from the feed, `overlay(gen)` from
local speculation, plus its own pending source commits (localSeq). Rules:

1. Client applies its own source write locally → recomputes derived into
   overlay generation `g`, tagged "based on my source commit `L`".
2. Server-derived commits arrive on the feed with watermark `W` = max input
   seq consumed. The client's source commit `L` was assigned global seq
   `S(L)` at confirmation (the confirmation already returns this).
3. For a derived doc: drop overlay entries whose basis `S(L) ≤ W` — the
   server has seen everything the speculation was predicting. If `W <
   S(L)`, keep the overlay (server hasn't caught up to my write yet); the
   confirmed value updates underneath and the overlay recomputes from it.
4. Divergence (overlay ≠ confirmed at drop time) is *expected occasionally*
   (cross-client interleaving, nondeterminism) and resolves in favor of the
   server silently; it is a metrics counter, not an error.

No new consistency primitive is required: watermark = `observedAtSeq`,
`S(L)` = the commit-confirmation seq that memory-v2 already assigns. The
seq-token draft (#4139) is this rule's ancestor and is subsumed by it.

#### B.5 Async builtins

Builtins run **only** on the executor. Client-side builtin actions register
in passive mode: they materialize `pending` from the request cells and
never issue network work (deleting the cross-tab mutex dance). Streaming
LLM partials are executor writes into the `partial` cell flowing down the
ordinary feed (66ms batching + 5ms refresh ≈ visually identical). Request
dedup collapses from "N tabs racing a cell mutex" to "one executor
consulting its own in-flight table keyed by `(actionId, inputHash)`" —
the key already exists (`{kind}:{inputHash}` effect idempotency,
`packages/runner/src/cfc/types.ts:344`). Durable in-flight markers stay in
the request cells so an executor restart resumes or re-issues
deterministically (G12: streaming partials need either idempotent re-issue
or durable chunk append; recommend re-issue for v1).

#### B.6 Scoped state (PerUser / PerSession): transitional carve-out, not the end-state

Reader isolation is a storage-partition + ACL property (`user:<did>`,
`session:<id>`), not a CFC-label property, so a space executor cannot read
user partitions without new grants. The **end-state is that the executor
computes scoped derivations too**: the trust-asymmetry goal (§5.B.7) wants
*all* derived data — including user-scoped — to be executor-computed so
its integrity can be endorsed for downstream consumers. Leaving scoped
derivation on clients permanently would put the integrity hole exactly
where the most personal data lives. That is more machinery, so it phases:

- **Space-scoped only (initial B).** Scoped derivation stays
  client-executed and client-committed as today; the executor's demand
  roots exclude scoped subtrees (the scheduler already treats scope as
  part of the address, so the graph partitions cleanly). Races within one
  user's own tabs are the only residual derived races. In this phase the
  executor's identity story is minimal: one principal + one WRITE grant
  per space (G1/G2) — no impersonation, no delegation chains, no event
  signatures.
- **User-scoped on the executor.** Requires delegated read/write grants on
  `user:<did>` partitions — granted by the *user*, not the space owner
  (G3) — and per-user demand roots inside the space worker (or per-user
  sub-sessions of it). This is where G3's delegation machinery enters B's
  own roadmap rather than being C-only.
- **Session-scoped on the executor.** Natural once events ship down
  (§5.B.3 end-state): the event stream carries session identity, so the
  executor can maintain live per-session subtrees for connected sessions;
  session state of *disconnected* sessions has no consumers by
  construction.

Two consequences elsewhere in the stack:

- The RI currently refuses to interpret scoped outputs. As a client-side
  fallback that was tolerable; for the executor it is a real gap — scoped
  derivation is precisely where trusted execution is wanted — so RI
  scoped-output interpretation graduates from design exclusion to work
  item (G16).
- Executor-computed scoped writes need the same endorsement treatment as
  space-scoped ones (§5.B.7): the integrity claim is "computed by the
  trusted executor from these inputs", regardless of scope.

#### B.7 Identity and CFC

- The executor's derived writes carry the verified implementation identity
  of the module that produced them — the same WeakMap-provenance modules
  the client would have run — so `writeAuthorizedBy` and structural
  provenance gates behave identically
  (`packages/runner/src/cfc/prepare.ts:310–481`).
- Flow labels are data-derived, so a trusted executor reading space-scoped
  inputs and emitting labeled outputs is CFC-coherent; D4 (per-write
  prefix provenance) applies unchanged.
- New: mint a **first-class executor principal** per deployment (precedent:
  the constant `cf-compiler` atom), granted per space by owners on opt-in;
  its writes are attributable and revocable (G1, G2).
- **Integrity endorsement of computations.** Because the executor is more
  trustworthy than any client, its derived commits can mint an endorsement
  atom — *executor-computed* — analogous to `LlmDerived` /
  `ExternalIngest`, carrying the producing action identity and the input
  watermark. Downstream consumers (other patterns, egress gates, and
  verifiable-execution receipts later) can then *require*
  executor-computed integrity for sensitive flows — a claim
  client-computed derived data could never honestly make. This is a
  first-class reason for server-primary execution, not a side effect
  (G1 extends to cover the atom), and it is why scoped derivation must
  eventually move to the executor too (§5.B.6).
- Trusted-event gates (`uiContract`) still fire on clients, where the DOM
  events are — B never needs a serialized event proof.

#### B.8 Failure modes

- **Executor down / space not served:** flag flips the space back to
  today's mode (clients commit derived writes again). This must be a
  per-space runtime switch, not a deploy — it is also the migration lever
  (§8). Anti-flap: the switch is sticky per epoch so clients and executor
  don't disagree about who owns derived data (G5b: the ownership bit lives
  in space config, versioned by seq like everything else).
- **Client offline:** source writes queue (pending commits), overlay keeps
  the UI coherent; on reconnect the server catches up. True offline
  (persisted pending queue) remains a separate, orthogonal gap — the
  replica is in-memory today.
- **Executor crash mid-settle:** observations persist per commit;
  restart rehydrates and re-runs only actions whose inputs moved. Bounded
  by scheduler-v2's budget + backoff gates.
- **Divergent speculation:** silent server-wins; counted.

#### B.9 Performance model

Per space with C connected clients, piece graph of size G, event rate E:

- Executor compute: 1 × G-scaled settle work (vs C× today), plus event
  commit validation (unchanged).
- Client compute: UI-relevant subset of G, discardable; can be *lazily
  warmed* — first paint can come entirely from server-derived state, then
  local speculation warms up in the background. The browser compile wedge
  leaves the critical path (it only gates speculation warm-up and handler
  execution, and handlers compile per-module on demand).
- Server subscription serving: from O(commits × sessions × graph re-eval)
  to O(commits × sessions × set-membership + patch size) — §6.4.
- Store: derived docs written once per change (by the executor) instead of
  once per client + conflict retries.
- New costs: executor pool memory (∝ active spaces; hibernation via
  persisted state, §6.5), and the feed fan-out (cheap: doc-id filtering).

**Verdict.** B delivers the goal — no derived races, reliable async, cheap
clients — with the smallest protocol change that gets there: the wire keeps
exactly today's commit + confirmation + feed shapes, plus one watermark
field and one interest declaration. Its risk concentrates in the runner
(the write split + overlay, G5) and the executor pool (§6), both of which A
de-risks first.

---

### Approach C — Event shipping (server runs handlers too)

**Model.** Clients do not commit at all. A UI event becomes a **signed
event envelope**: `{space, piece, handler-link, payload, provenance,
user-DID, session, nonce/expiry, signature}` — the request-proof format of
`toolshed-access-control.md:35` applied to events, replacing the
non-serializable WeakSet trusted-event mark
(`packages/runner/src/cfc/ui-contract.ts:95`). The server verifies the
envelope, marks renderer-trust server-side, and runs the handler in the
space executor with the event queue as the single per-space serialization
point. Clients speculate handler effects + derived locally and reconcile on
the event's ack (durable event IDs from #4088 give the ack identity).

**What it buys over B.**

- Zero client-side write authority → no client-induced write conflicts at
  all; the per-space event lane is a total order (the scheduler's event
  FIFO already is one; decision 2's per-space lanes make it explicit).
- Handler reads are always against authoritative state — B.3's chained-
  interaction subtlety disappears.
- Clients become capable of running on trivial devices (they need handler
  *speculation* only for latency, not for correctness).

**What it costs.**

- The envelope + verification + replay-protection machinery (G13) — a real
  cryptographic protocol where B needs none.
- Handler authority semantics: the handler runs server-side but must act
  *as the user* for CFC (`ownerPrincipal` minting, per-user partition
  writes from handlers, trusted-event-gated `uiContract` fields). That
  means either delegation tokens (G3) or re-deriving "acting-as" from the
  envelope — new CFC surface that B avoids entirely.
- Latency floor: input → authoritative effect now includes a round-trip
  *before* the handler runs; speculation hides it for display, but any
  external effect of the handler (async kick-off) waits.
- PerSession state referenced by handlers must be readable server-side —
  solvable once the executor maintains live per-session subtrees for
  connected sessions (§5.B.6's final phase, which the event stream itself
  enables by carrying session identity); until then, session-heavy
  handlers stay client-run.

**Verdict.** Not the next step, but the **end-state for events**: the
target model is dual execution — the event ships to the server, the
handler runs there authoritatively *and* on the client speculatively, the
client's run reconciled by the event's durable ID and ack (§5.B.3). Dual
execution is also what closes B's residual speculation window and, via the
session identity the event stream carries, unlocks session-scoped
execution (§5.B.6). Sequencing is unchanged — B first, because dual
execution needs everything B builds plus the envelope. Design the envelope
format alongside B (so `queueEvent`'s durable IDs and provenance survive
serialization); adopt per-handler (`serialize: "server"` for contended
handlers, headless/API clients) as the on-ramp before it becomes the
default event path.

---

### Approach D — Thin projector (server renders everything)

**Model.** Clients run nothing: the server computes all derived data
*including VNode docs* (the RI-branch §4.8 consolidation stores rendered
VNode subtrees inline in docs — on the RI branch, not main), and clients
are DOM projectors: materialize VNode docs via the existing reconciler,
send events (as C envelopes), echo input locally.

**Why it is not a separate destination.** D = C with speculation deleted.
Everything D needs, B/C build; whether a given client *chooses* to run the
speculative graph is then a client policy (device class, battery, page
type). The interesting D-specific observation: once the executor computes
VNode docs, **first paint requires zero pattern execution on the client** —
boot becomes "open feed, materialize VNode docs" — which is worth having as
a *mode* regardless (fast cold loads, embeds, previews, native shells).

**Why not lead with it.** Input latency (every keystroke/hover-derived
update is a round-trip unless the pattern splits interactive state into
PerSession cells — most don't today); PerSession/render entanglement
(render effects read session state); and it maximizes the identity surface
(everything C needs). Revisit after B, as "projector mode" for cold start
(§8 phase 3) rather than as the execution model.

---

## 6. The server executor (shared architecture for A/B/C/D)

### 6.1 Topology: worker-thread-per-space, co-located with the engine

One **executor pool** service co-resident with the memory engine (initially
inside toolshed; separable later). Per *active* space: one Deno Worker
running one Runtime — the bps shape
(`packages/background-piece-service/src/worker-controller.ts:78`), kept for
three reasons: realm isolation is *required* (two runtimes in one realm
cross-talk through verified-load registries and break CFC identity — the
multi-runtime-harness lesson, `packages/patterns/integration/multi-runtime-harness.ts:20`);
a worker is a natural unit of resource accounting and crash isolation; and
worker-per-space makes the executor the **single writer of derived data per
space**, which is what deletes the races. Workers, not subprocesses, by
default: bps proves the model, spawn is cheap, and structured-clone IPC to
the engine thread is enough. A subprocess tier stays on the menu (§6.6) for
hard isolation once pattern code is less trusted than today.

Threading note: the engine's SQLite reads are synchronous FFI on the engine
thread; executor workers do **not** open the database. They talk to the
engine over an in-process channel (below). This respects the single-writer
engine assumption and keeps WAL discipline in one place.

### 6.2 Storage transport: in-process, no subscriptions

Stage 1 (zero new code): executor workers connect via the `loopback`
transport (`packages/memory/v2/client.ts:1299`) to the same `Server` object
— functionally correct, still pays session/watch machinery.

Stage 2 (the real design): an **executor-grade provider** implementing
`IStorageProviderWithReplica` (`packages/runner/src/storage/interface.ts:264`)
that (a) reads through the engine's read pool directly
(`packages/memory/v2/server.ts:711`) with MessageChannel batching, (b)
commits via `applyCommit` directly, and (c) receives invalidations from the
engine's commit stream as a per-space callback — **not** via
`session.watch` graph queries. The executor's own scheduler trigger index
is the subscription; the engine just tells it "space S, commit at seq N,
docs D₁..Dₖ changed". This is the "replace the cell-get mechanism with
reading the local sqlite" goal, expressed at the provider seam so the
runner is unchanged.

### 6.3 What runs: interest sets

A space is *active* when any of:

1. a client session declares interest — the client already knows its open
   pieces (space root pattern + navigated piece); a new
   `session.interest.set {space, pieceIds | "*"}` message replaces
   `session.watch.set` (G7). `.pull()`-driven fine-grained interest is a
   later refinement — pull is one-shot today
   (`packages/runner/src/cell.ts:1032`) and there is no standing pulled-set
   to export (agent-verified gap);
2. a persisted registration says so (BG pieces, timers, webhooks — today's
   bps registry generalized);
3. an incoming commit touches a doc that the **persisted read index** maps
   to some piece's stale downstream (the §3.2 readers index) — wake, catch
   up, hibernate.

Within an active space the executor's demand roots are: each interested
piece's result graph (coarse per-piece demand — matches the space-root
model) minus scoped subtrees (B.6), plus async builtins, minus render
effects unless projector mode is on.

### 6.4 Client feed (replacing graph-query subscriptions)

Per session: the union of interest closures — maintained **by the
executor's scheduler** (it already holds every interested piece's read
closure as node reads; exported per piece, updated on read-delta) — becomes
a doc-id set in the engine. Commit fan-out is then: for each affected
session, set-membership filter → push patch ops (+ derived watermark). The
per-session graph re-evaluation (`refreshTrackedGraph`) disappears for
executor-served spaces; the session catch-up path (`fromSeq`/`toSeq`,
`packages/memory/v2/server.ts:2187`) already handles reconnect. Cross-space
links: the closure naturally names remote docs; the feed for those rides
the same session against the other space (unchanged semantics, G9 for the
executor's own cross-space reads).

### 6.5 Lifecycle: spin-up, catch-up, hibernate

- **Spin-up** (interest or wake-commit): start worker → rehydrate
  observations for interested pieces (`rehydrateActionFromStorage`) →
  compare `observedAtSeq` vs branch head per read → run only stale actions
  (scheduler-v2 bounded settle) → serve.
  Cold-start cost without RI ≈ pattern load (compileCache, single-flighted)
  + rehydrate + stale subset; with RI v2, ROG artifacts replace pattern
  execution for the interpretable corpus. Pre-seeded system-pattern compile
  caches (the browser-wedge follow-up) apply server-side directly.
- **Catch-up without spin-up:** if the readers index shows no interested
  piece downstream of a commit, do nothing (the doc is stale but nobody
  cares — pull semantics, now durable). When a stale doc *is* demanded,
  the `source`→`pattern` walk on the doc itself names the piece to wake
  (§3.3), even with no scheduler state at all.
- **Hibernate** (idle timeout): flush observations, `closeSpace`
  (per-space teardown — landed, extended by #4115), terminate worker. The
  space's whole scheduler state is the observation rows.

### 6.6 Isolation and resources

- Pattern leaf code still runs in SES inside the worker (same sandbox story
  as clients); the RI shrinks how much code that is. Deno worker permissions
  pin the executor's net access to the engine channel + toolshed-internal
  routes (LLM proxy); pattern-level `fetch` egress goes through the fetch
  builtin, now server-side — apply per-space egress policy + the #2659-style
  throttles there (G11).
- Budgets per worker: memory cap, settle-pass budget (scheduler-v2), event
  lane depth, async concurrency (`runtime.getOrCreateQueue`). A space that
  exhausts budgets degrades to catch-up-on-demand rather than starving the
  pool.
- Pool sizing: workers ≈ active spaces, bounded LRU; hibernation makes the
  bound soft. Multi-machine sharding (space → executor affinity) is a later
  concern; single-writer-per-space makes it embarrassingly shardable by
  space DID (G14 notes the coordination primitive).

### 6.7 State residency: what lives in memory vs on disk

The scheduler state that replaces subscriptions exists in three tiers with
different residency and different correctness weight:

1. **Live tier — memory, per active space worker.** Node records, trigger
   index, liveness refcounts, gate timers. Authoritative *while hot*; this
   is what evaluates invalidations and drives the feed for connected
   sessions. Lost on worker crash or hibernation, by design.
2. **Durable tier — SQLite, transaction-coupled.** The observation rows
   (reads / writes / `observedAtSeq` / gate options per action,
   `packages/runner/src/scheduler/persistent-observation.ts:22`) plus the
   doc→readers index derived from them (G4), written in the same
   transaction as the commits they describe. Three consumers: rehydration
   on spin-up, wake-on-commit (the engine answers "does this commit make
   any parked piece stale?" with one indexed lookup, no worker running),
   and the derived-from watermark on commits (§5.B.4). The *producer*
   direction is not part of this tier at all: `source`/`pattern`
   annotations ride the docs themselves (§3.3) — write-side provenance is
   ground truth, not an index.
3. **Session tier.** The delivery cursor (`seenSeq`) is already durable in
   the session-resume sense. The per-session **interest declaration**
   (space + piece ids) is persisted with the session; the derived doc-id
   **closure is deliberately not persisted** — it is recomputed on session
   open from the declaration plus tier 2 (or the live scheduler when the
   space is hot), because closures churn with every read-delta and the
   durable read index is already their source of truth.

Rules that keep this sound:

- **Disk is an index of ground truth, not ground truth.** Commits and
  revisions remain the durable record; observations are a
  transaction-coupled projection of them. Because observation writes ride
  the same commit, the readers index can never be ahead of or behind the
  data it indexes — and the producer direction is carried *inside* the
  data (`source`/`pattern` annotations), so it cannot drift by
  construction.
- **Fail-open to recompute.** Missing, stale, or corrupt observations
  degrade to re-running actions (the persistent-scheduler-state spec's
  invariant: never incorrect cleanliness, at worst wasted recompute). The
  live tier is therefore always rebuildable: worker crash → rehydrate from
  tier 2; tier 2 damaged → cold re-run, i.e. today's behavior.
- **Per-commit work stays memory-resident for hot spaces.** Feed fan-out
  consults in-memory per-session doc-sets; the disk index is consulted
  per-commit only on the cold path (no worker, no sessions — the
  wake-on-commit lookup), a single indexed read (µs-scale; reads are
  synchronous FFI).
- **Growth and compaction.** Observations are last-write-wins per
  `actionId` (keep latest; no history requirement); no-op observations are
  batch-elided (`schedulerObservationBatch`, planned in the spec); a
  space's rows drop wholesale with the space.

---

## 7. Comparison and recommendation

| Criterion | A catch-up | B derived split | C event shipping | D projector |
| --- | --- | --- | --- | --- |
| Removes derived-data races | no (adds a writer) | **yes, structurally** | yes | yes |
| Removes redundant N× compute | no | yes (client compute optional) | yes | yes |
| Async reliability | **yes** | yes | yes | yes |
| Input→display latency | today | today (overlay) | today (speculation) | +RTT |
| Chained handler reads | today | today's retry semantics | authoritative | authoritative |
| Client cold start | today | fast (server state first, warm later) | fast | **fastest** |
| Subscription serving cost | today | set-membership feed | set-membership feed | set-membership feed |
| New identity machinery | WRITE grant | executor principal + WRITE grant (+ user-partition delegation in the scoped phase) | + signed envelopes | same as C |
| CFC surface touched | none | none new (labels data-derived) | trusted-event + acting-as | same as C |
| Runner changes | small | **write split + overlay (G5)** | + event serialization | + render split |
| Offline degradation | today | graceful (flag back per space) | needs envelope queue | poor |
| Incremental deliverability | **high** | high (per-space flag) | medium | low |
| Revertibility | trivial | per-space flag | protocol migration | protocol migration |

**Recommendation.** A → B → scoped execution → dual handler execution,
with C's envelope designed (not built) from the start:

1. **A** builds the executor pool, in-process provider, interest registry,
   executor identity/grants, and async ownership — all §6 — with zero
   client-protocol risk, and immediately fixes async fragility.
2. **B** flips derived authority per space behind a flag once the §9
   runner gaps close. It removes the races the whole exercise is about
   while keeping today's wire shapes and CFC model essentially intact.
3. **Scoped execution** extends B to user-scoped derivation via delegated
   grants (G3), then session-scoped once events ship — closing the
   integrity hole rather than leaving a permanent client-computed
   carve-out (§5.B.6).
4. **C — dual handler execution** as the end-state for events: envelope
   designed from day one (durable event IDs and provenance
   serialization-ready), adopted per-handler, then as the default event
   path.
5. **D-projector** as a boot *mode* riding B (server-computed state first
   paint), contingent on the RI/VNode consolidation landing.

---

## 8. Phased plan

Phases assume #4288 and the persistent-scheduler-state wiring land first;
RI (#4514) accelerates but does not gate any phase.

- **Phase 0 — foundations (gap closure).** Persistent-state memory tables +
  commit wiring + doc→readers index (G4); executor principal + per-space
  grant flow (G1/G2); in-process executor provider stage 1→2 (G0);
  `session.interest.set` + doc-set feed behind a flag (G7).
- **Phase 1 — Approach A.** Executor pool serves opted-in spaces
  reactively; async executor-priority rule; bps registry folds into
  interest sets. Exit criteria: cold space catch-up ≤ seconds; zero
  double-fired async in multi-tab tests; executor-served spaces' feed
  latency ≈ today's watch latency.
- **Phase 2 — Approach B per-space flip.** Runner write split + overlay
  (G5); derived-from watermark on commits (G10); builtin passive mode;
  transitional scope carve-out enforcement (executor demand roots exclude
  scoped subtrees). Flip flagged spaces; measure conflict rate (expect ≈0
  derived conflicts), multi-client action volume (expect ~1×), divergence
  counter. Fallback: per-space flag back to legacy mode.
- **Phase 3 — subscriptions retired + projector boot.** Executor-served
  spaces drop `session.watch` graph queries entirely; cold clients paint
  from server state before local warm-up; projector mode where VNode docs
  exist.
- **Phase 4 — scoped execution.** User-partition delegation (G3) +
  per-user demand roots; executor endorsement atom on scoped writes; RI
  scoped-output interpretation (G16) if RI is the executor engine by then.
- **Phase 5 — dual handler execution (C).** Signed event envelopes
  (`serialize: "server"` handlers first, then the default event path);
  the server runs handlers authoritatively while clients keep running them
  speculatively; session-scoped execution rides the event stream.

---

## 9. Gap register

Gaps that remain **after** the assumed in-flight work lands. "needs-spec"
means a design doc/decision is required before implementation.

| # | Gap | Blocks | Status |
| --- | --- | --- | --- |
| G0 | Executor-grade in-process storage provider (engine-thread channel; commit-stream invalidations instead of watch) | A | needs-impl; `loopback` + `emulate` prove the seam |
| G1 | First-class executor principal + executor-computed endorsement atom (`cf-compiler` / `LlmDerived` precedents) | A (principal), B (atom) | needs-spec (small) |
| G2 | Per-space executor grant flow (owner opt-in → ACL WRITE for executor; revocation) | A | needs-spec; ACL mechanism exists |
| G3 | Delegation/capability tokens (user → executor, scoped) | scoped-execution phase (user-scoped derivation); C | needs-spec (large); not needed for initial space-scoped B |
| G4 | Persistent-state memory tables + commit-pipeline wiring + doc→readers index from persisted read sets (spec §9); doc→producer needs no index (`source`/`pattern` chain, landed) | A (wake-on-commit), B (watermarks) | spec exists; needs-impl |
| G5 | Runner write split: route tx by originating action kind; speculative overlay in `ISpaceReplica`; read layering; per-space ownership bit (sticky flag) | B | needs-spec (this doc §5.B.1) + impl |
| G6 | Source-chain coverage audit: every executor-reachable doc must terminate the `source` walk at a `pattern`-bearing root (suspects: builtin-created docs, schema-less writes, external ingest) | catch-up completeness | needs-audit, then targeted fixes |
| G7 | `session.interest.set` + doc-set delta feed (+ watermark field); closure export from executor scheduler | A (feed), B | needs-spec (protocol addition) |
| G8 | RI gates: cross-space pull-amplification loop; F4 I/O coalescing ratchet; scoped-output exclusion (by design) | RI-on-executor only | tracked in RI specs; not on B's critical path |
| G9 | Executor cross-space reads (remote-space sessions from the executor; reader-isolated cross-space docs) | B completeness | needs-design; today's client semantics reusable |
| G10 | Watermark surfacing: `observedAtSeq` onto derived commits; confirmation already returns source seq | B reconciliation | small, rides G4 |
| G11 | Server-side async policy: per-space egress/throttle (#2659), retry/circuit-breaker, in-flight registry keyed `(actionId, inputHash)`, heartbeat/reclaim | A | partial (idempotency keys, toolshed LLM cache exist); needs-impl |
| G12 | Durable LLM streaming (re-issue vs chunk append on executor restart) | A polish | needs-decision (recommend re-issue v1) |
| G13 | Signed event envelope format (serialize trusted-event provenance; replay protection; verify path) — design now, build in Phase 5 | dual handler execution (C) | needs-spec; request-proof precedent exists |
| G14 | Multi-executor coordination (space→executor affinity lease) | multi-machine scale | needs-spec later; single-writer-per-space makes it a lease, not consensus |
| G15 | Client pending-commit durability (true offline) | orthogonal | out of scope here; noted |
| G16 | RI scoped-output interpretation (excluded by design today; required once the executor computes scoped derivations) | scoped execution on RI | needs-design in RI v2 |

Cross-engine idempotency (the intent/attempt-cell ledger from
`cfc-runner-future-work.md` Tier 2) is deliberately *not* listed as a B
blocker: under B a derived action runs on exactly one engine (the space
executor), and handler re-execution stays client-side under today's retry
semantics. It becomes relevant with executor failover (G14); under dual
handler execution the client's speculative run never commits, so the
single authoritative run per event is preserved.

## 10. Open questions

1. **When does dual handler execution become the default event path
   (§5.B.3)?** Per-handler opt-in is the on-ramp; the trigger for flipping
   the default (contention data, headless-client demand, integrity
   requirements on handler writes) should be named in advance.
2. **Interest granularity (§6.3):** per-piece is proposed; is per-space
   ("serve everything running here") acceptable for v1 given typical space
   sizes, or do large spaces need per-piece from day one?
3. **Executor identity per deployment vs per space (§9 G1):** one principal
   simplifies ops; per-space principals improve blast-radius and audit.
   Proposal: one principal, per-space grants.
4. **Shape of user-partition delegation (G3):** a standing grant (user →
   executor, revocable, per space) vs short-lived tokens minted at session
   time; and does user-scoped execution get its own sub-worker per user or
   per-user demand roots inside the space worker?
5. **Where does the executor pool live long-term:** inside toolshed
   (co-process, simplest) vs a sibling service with the engine extracted
   behind the in-process channel? Phase 1 forces no commitment; the
   provider seam (G0) is the interface either way.
6. **Render effects on the executor (D-mode):** gate on RI §4.8 landing, or
   build a compiled-path VNode materialization for projector boot? Proposal:
   gate on RI; projector mode is Phase 3+.
