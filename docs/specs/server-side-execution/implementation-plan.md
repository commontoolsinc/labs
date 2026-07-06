# Server-Primary Execution — Implementation Plan

Companion to [README.md](./README.md) (the design). Read the README first;
this plan does not restate the design rationale. Section references
(§5.B.3, G4, …) point into the README.

Status: plan for Phases 0–2 in executable detail; Phases 3–5 outlined with
entry criteria only (they depend on decisions and landings listed at the
end). Scope decision from review: direction is A → B → scoped execution →
dual handler execution.

---

## 0. How to use this plan (implementing agents)

- **One work order (WO) = one PR.** Do not bundle WOs. If a WO turns out
  too big for one PR, split at the test boundaries listed in its success
  criteria and say so in the PR description.
- **Read-first lists are mandatory.** Every WO names the files/specs that
  define its seams. Read them before writing code. If the code you find
  contradicts a step here (line numbers drift, a helper was renamed), the
  code wins — adapt, and note the delta in the PR description. Do not
  invent parallel mechanisms when the named seam exists.
- **Red-green.** For every behavioral criterion, write the failing test
  first, confirm it fails for the right reason, then implement. PR
  descriptions must show the red→green transition for the headline test.
- **Flags default off.** Nothing in Phases 0–2 may change behavior when
  its flag/option is off. Every WO with a flag has a parity criterion;
  treat it as the most important one.
- **Commit style.** Small coherent commits as work completes. Follow
  existing message conventions (`feat(runner): …`, `test(memory): …`).
- **When blocked**, stop and surface the blocker with what you learned;
  do not work around a failed criterion by weakening the test.

### 0.1 Repo practices you must follow (with reasons)

- `docs/development/TESTING.md`, `docs/development/DEVELOPMENT.md`,
  `docs/development/LOCAL_DEV_SERVERS.md` — house rules. Use `dev-local`
  for shell, not `dev`.
- **Any test/dev server: always `--port-offset`**, never default `:8000`
  (a stale toolshed on 8000 produces "No data at cell" wire-skew ghosts).
- **Never construct a second Engine/runtime realm in one process** in
  tests — verified identities degrade and CFC gates start failing
  (`writeAuthorizedBy unsupported`). Multi-runtime tests use Deno Workers:
  see `packages/patterns/integration/multi-runtime-harness.ts` and
  `packages/cli/lib/multi-user-test-runner.ts`.
- **Await `runtime.settled()`** (not `idle()`) when a test depends on
  async-builtin writebacks (post-commit outbox).
- **Do not repro flakes by running the same test file ×N in one command**
  — repeated runs share `$TMPDIR` sqlite state and invalidate the repro.
- `cf test` fails on console errors/warnings — leave no stray logging.
- New workspace packages MUST have a `"test"` task in their `deno.jsonc`
  (root `AGENTS.md` explains why; see `packages/utils/deno.jsonc`).
- Perf-check: if the Performance Check job flags a change you believe is
  noise, rerun ONLY that job (up to 3×) before considering
  `NEW_PERF_BASELINE` with justification.

### 0.2 Definition of done — every PR in this plan

1. `deno task check` green; the touched packages' `deno task test` green
   locally.
2. All success criteria of the WO checked off in the PR description, each
   with the test file/name that proves it.
3. Flag-off parity criterion (when the WO has a flag) proven by a test,
   not by inspection.
4. CI green on the PR (docs job, runner/memory/pattern shards). Address
   automated-reviewer comments (fix or rebut with evidence).
5. No new schema-less deep sinks or whole-state subscriptions anywhere
   (this family of change caused a ~270× re-run amplification before;
   reviewers will look for it specifically).

### 0.3 Naming reserved by this plan

- Runtime option: `persistSchedulerState: boolean` (default false).
- Runtime/provider option: `storageConnection: "remote" | "in-process"`.
- Env flags: `CF_INTEREST_FEED` (client), `EXECUTOR_MODE=reactive` (bps).
- Protocol messages: `session.interest.set`.
- Space config doc key: `executorConfig` (fields:
  `{ enabled, derivedAuthority: "client" | "executor", epoch }`).
- Tx envelope type: `TxProvenance`
  (`{ source?, action?: { id, kind }, observedAtSeq? }`).

---

## 1. Dependency graph

```
Phase 0:  W0.1 ──▶ W0.2 ─────────────▶ W1.3
          W0.3 (independent)───────────▶ W2.2, W2.3
          W0.4 (independent)───────────▶ W1.1, W2.1
          W0.5 ──▶ W0.6 ──────────────▶ W1.1
          W0.7 (independent)───────────▶ W1.1 discovery, Phase 3

Phase 1:  W1.1 ──▶ W1.2, W1.3, W1.4
Phase 2:  W2.1 ──▶ W2.2 ──▶ W2.3 ──▶ W2.6
          W2.4 (after W2.1 + W1.2); W2.5 (after W1.1) — both parallel
          with W2.2/2.3
```

Parallelizable start set: W0.1, W0.3, W0.4, W0.5, W0.7.

---

## 2. Phase 0 — foundations

### W0.1 — Persist scheduler observations transactionally

**Depends on:** nothing. **Unblocks:** W0.2, W1.3.
**Deliverable:** one PR: observation rows written in the same SQLite
transaction as the commit they describe; readable back through the
existing provider seam. Gated by runtime option `persistSchedulerState`
(default false).

**Read first:**

- `docs/specs/persistent-scheduler-state.md` (the chosen storage design:
  hybrid "Option B", transaction-coupled) and
  `docs/specs/persistent-scheduler-state/implementation_notes.md`.
- `packages/runner/src/scheduler/persistent-observation.ts` — the shapes
  already exist: `SchedulerActionObservation` (line ~22),
  `PersistedSchedulerObservationSnapshot` (~47),
  `buildSchedulerActionObservation()` (~76).
- `packages/runner/src/scheduler.ts` — `rehydrateActionFromStorage`
  (~666) and `rehydrateActionFromObservation` (~593); subscription options
  `rehydrateFromStorage` / `awaitSyncBeforeInitialRun` (~528).
- `packages/runner/src/storage/interface.ts` — the optional provider
  methods `listSchedulerActionSnapshots?` (~271) and `sqliteQuery?`
  (~276).
- `docs/specs/memory-v2/02-storage.md` (tables/migrations) and
  `docs/development/patch-operations.md` (the one-place registry for
  anything commit-carried).

**Steps:**

1. In `packages/memory` add a `scheduler_observation` table (migration per
   02-storage.md conventions): columns `(space, branch, piece_id,
   action_id, observed_at_seq, kind, payload_json, updated_at_seq)`,
   primary key `(space, branch, action_id)` — last-write-wins per
   `actionId`, no history.
2. Extend the commit payload with an optional
   `schedulerObservations: SchedulerActionObservation[]` field. Follow the
   patch-operations registry pattern (commit `02938e3f8` is the model for
   "define once, used by memory/runner/api"): one definition, wire codec,
   server apply. The server writes rows inside the SAME sqlite
   transaction as the commit/revision rows in `Engine.applyCommit`
   (`packages/memory/v2/server.ts` ~1628 call site).
3. No-op elision: before attaching an observation to a commit, compare
   against the last-persisted snapshot for that `actionId` (cache it on
   the provider); skip identical payloads. Name the helper
   `schedulerObservationBatch` (the spec reserves the name).
4. In `packages/runner`, at the point where `buildSchedulerActionObservation`
   output is available after an action run (find the caller in
   `packages/runner/src/scheduler/` — it exists for the in-memory
   rehydration path), attach observations to the transaction when
   `persistSchedulerState` is on.
5. Implement `listSchedulerActionSnapshots` on the v2 provider
   (`packages/runner/src/storage/v2.ts`, class `Provider` ~1074) reading
   the table (via the read path, not a raw side-channel).
6. Wire the runtime option: `persistSchedulerState` plumbed from Runtime
   construction (see how `ExperimentalOptions` flow — commit `48172859a`
   is a recent example of plumbing one option through shell / toolshed /
   bps / CLI).

**Success criteria (each = a named test):**

- [ ] `packages/memory`: applying a commit carrying observations writes
      commit rows AND observation rows atomically; a commit that
      **conflicts** writes NEITHER (assert row absence after rejected
      commit).
- [ ] `packages/memory`: two observations for the same `actionId` →
      single row, latest payload (LWW).
- [ ] `packages/runner`: with `persistSchedulerState: true`, run a fixture
      pattern; dispose the runtime; construct a NEW runtime on the same
      store with `rehydrateFromStorage`; assert (via an invocation counter
      inside the fixture's lift) that unchanged actions do NOT re-run,
      and that after writing one input, exactly the dependent action
      re-runs.
- [ ] Fail-open: delete all observation rows between the two runtimes →
      second runtime re-runs everything and produces identical results
      (byte-compare result docs), no errors.
- [ ] Parity: with the option off (default), no observation rows are ever
      written, and an existing scheduler test file of your choice passes
      unmodified.
- [ ] No-op elision: run the same fixture twice without input changes →
      zero new observation writes on the second settle (assert write
      count via test hook).

**Review checklist:**

- Observation write is inside `Engine.applyCommit`'s transaction, not a
  second transaction (grep the diff for a second `BEGIN`/`transaction`
  call — reject if found).
- The commit-payload extension went through the patch-operations single
  registry, not an ad-hoc parallel field.
- Rehydration degradation is fail-open (spec invariant: never incorrect
  cleanliness). Look for any code path that trusts a snapshot without
  checking `implementationFingerprint`/`runtimeFingerprint` match.
- The invocation-counter fixture actually counts lift executions, not
  subscriptions.

---

### W0.2 — doc→readers index + wake query

**Depends on:** W0.1. **Unblocks:** W1.3.
**Deliverable:** one PR: an indexed reverse mapping (space, docId) →
(pieceId, actionId, observedAtSeq) maintained from observation read sets,
plus an engine-side query `staleReadersFor(space, changedIds, seq)`.

**Read first:** W0.1's code; `docs/specs/persistent-scheduler-state.md`
§9 (server-side read/write indexes); `packages/memory/v2/server.ts`
`markSpaceDirty` (~1051, ~2320) — the post-commit point where changed ids
are already in hand.

**Steps:**

1. Add `scheduler_read_index` table: `(space, branch, doc_id, action_id,
   piece_id, observed_at_seq)`, indexed on `(space, branch, doc_id)`.
   Populate/replace rows in the same transaction as the observation write
   (delete-then-insert per actionId; read sets come from
   `observation.reads` + `shallowReads`).
2. Implement `Engine.staleReadersFor(space, changedIds, commitSeq)`:
   one indexed SELECT returning distinct `(pieceId, actionId)` where
   `doc_id IN changedIds AND observed_at_seq < commitSeq`.
3. Expose it as an engine/server method (no wire protocol yet — Phase 1
   consumes it in-process).

**Success criteria:**

- [ ] `packages/memory`: after a fixture observation batch, querying a
      changed doc id returns exactly the reading actions; querying an
      unread doc id returns empty.
- [ ] Staleness bound respected: readers whose `observed_at_seq` ≥ commit
      seq are NOT returned (they already saw it).
- [ ] Index rows are replaced, not accumulated: re-observing an action
      with a smaller read set removes the stale rows (assert row count).
- [ ] Micro-sanity: query over a space with 10k index rows returns in
      < 5ms in a plain `deno bench`/timed test (reads are sync FFI; this
      is generous).
- [ ] Same-transaction guarantee: a conflicted commit leaves the index
      untouched.

**Review checklist:** the query must key on `(space, branch, doc_id)` via
the index (check the query plan comment or EXPLAIN in a test); deletion on
re-observation must be per `(space, branch, action_id)`.

---

### W0.3 — Tx provenance envelope + `source` stamping (§3.3.1)

**Depends on:** nothing (parallel with W0.1). **Unblocks:** W2.2, W2.3.
**Deliverable:** one PR: `TxProvenance` populated at action-tx open,
carried on the commit, and transferred by the storage layer onto every
document the transaction CREATES, as the doc-level `["source"]` field.

**Read first:**

- README §3.3–§3.3.1 (the design, including the two open details:
  cross-space and setup-tx anchoring — both have decided v1 behaviors
  below).
- `packages/runner/src/scheduler/action-run.ts` ~307–348 — the existing
  stamp: `(tx.tx as …).debugActionId = actionId; tx.tx.sourceAction =
  action;`.
- `docs/specs/memory-v2/01-data-model.md` (document envelope: `source` is
  a same-space short-link `{"/":"<short-id>"}`; `pattern` is a sigil
  link) and `docs/specs/memory-v2/05-queries.md` §5.10.1 (traversal does
  NOT follow `source` — fine: our walk is store-direct, not query-layer).
- `packages/runner/src/cfc/prepare.ts` ~1148–1210 — the raw `["source"]`
  surface is already excluded from CFC flow reads. Do not change these
  exclusions; they are what make stamping label-neutral.
- `packages/runner/src/result-utils.ts:17` — where `pattern` meta is
  written (the walk's terminator).
- `packages/state-inspector/db.ts` — offline store reads (for the walk
  helper + audit).

**Steps:**

1. Define `TxProvenance` in `packages/runner/src/storage/` (new
   `provenance.ts` or alongside the tx types):
   `{ source?: <short-link>, action?: { id: string, kind:
   "computation" | "effect" | "event-handler" }, observedAtSeq?: number }`.
2. Populate at the two tx-open sites:
   - action runs (`action-run.ts` — replace/extend the `sourceAction`
     stamp; keep the old field working until all readers migrate, then
     remove it in the same PR if the migration is complete);
   - event-handler dispatch (`packages/runner/src/scheduler/events.ts`).
   The `source` anchor = the piece root doc id. Resolve it the same way
   the observation builder resolves `pieceId` (find
   `buildSchedulerActionObservation`'s call site and reuse its
   resolution; do NOT invent a second piece-resolution path).
3. Carry it on the wire: add an optional `provenance` field to the commit
   payload via the patch-operations registry (same pattern as W0.1 step
   2; coordinate if both PRs are in flight).
4. Transfer at apply: in `Engine.applyCommit`, for every entity the
   commit CREATES (no prior revision row for that id), synthesize the
   `["source"]` write from `provenance.source` as part of the same
   commit application (recorded in `revision` like any write). Mirror the
   identical rule in the runner's local optimistic apply
   (`packages/runner/src/storage/v2.ts`) so replicas match without
   waiting for the server echo.
5. v1 policy decisions (already made in review — implement, don't
   re-litigate):
   - **creation-only**: later writes never re-parent (`source` immutable
     once set);
   - **same-space only**: if the created doc's space ≠ the anchor's
     space, skip stamping (walk returns null; counted);
   - **setup txs**: anchor = the creating context's piece root (parent
     piece) or, for the space-root pattern itself, unset.
6. Walk helper + audit: in `packages/state-inspector`, add
   `followSourceToPatternRoot(space, docId)` returning the pattern-root
   doc id or null, and a `cf inspect` subcommand (or extend an existing
   one) that reports, for a space: total docs / docs with terminating
   chain / orphans grouped by creator hint. This is the G6 audit tool.
7. Server-side writers: toolshed ingest handlers (`POST /api/ingest/:id`,
   `packages/toolshed/routes/ingest/`) populate the commit's provenance
   with `{ source: <ingest-channel doc id> }` so the engine-side transfer
   stamps ingest-created docs too. Sqlite-builtin result writebacks ride
   the builtin action's own tx envelope and need no special handling.

**Success criteria:**

- [ ] Red→green headline: an integration-style runner test runs a fixture
      pattern that (a) creates docs from a lift, (b) creates docs from a
      handler, (c) runs a builtin (`fetchJson` against a local stub)
      whose result cells are created, then asserts via the walk helper
      that EVERY doc created during the run terminates at a
      `pattern`-bearing root. This test must exist and fail before the
      stamping lands (red run linked in the PR).
- [ ] Creation-only: a second tx (different action) writing an existing
      doc does not change its `["source"]` (assert byte-equality of the
      field across the write).
- [ ] Cross-space: fixture writing into a second space → stamping
      skipped, walk returns null, and the audit counts it (pin the
      behavior; do not silently pass).
- [ ] CFC neutrality: run an existing CFC-heavy test file
      (reviewer picks; suggestion: one of the S16/observation-class
      suites) unmodified — green. Plus a targeted test: stamping a doc
      does not add flow-read/label entries (assert via the CFC policy
      inputs on a prepared tx).
- [ ] Wire compatibility: commits WITHOUT the provenance field (old
      clients) still apply — docs simply get no `source` (test with a
      hand-built commit payload).
- [ ] Local/remote parity: after a run against an in-process server, the
      client replica's doc envelopes equal the server store's (compare
      `["source"]` for a sample of created docs).
- [ ] Audit tool: `cf inspect` walk-coverage subcommand runs against a
      seeded space fixture and prints the coverage report (golden-ish
      test on its output shape, not exact counts).
- [ ] Ingest anchoring: a doc created through the ingest route walks to
      the ingest-channel doc (route-handler test).

**Review checklist:**

- The apply-side stamp must be inside the commit transaction and recorded
  as a normal revision write (otherwise catch-up/replication would miss
  it).
- Check the CFC exclusion list was NOT widened (the diff should not touch
  `prepare.ts` exclusion predicates at all).
- Confirm the piece-root resolution is shared with the observation
  builder, not duplicated.
- Look for the classic trap: stamping in the runner only (client-side)
  — server-created docs (ingest, sqlite builtin server writes) must get
  stamped by the engine-side transfer too. Ask where ingest txs get
  their anchor (README §3.3.1: the ingest-channel doc).

---

### W0.4 — Executor principal + per-space grant flow

**Depends on:** nothing. **Unblocks:** W1.1, W2.1.
**Deliverable:** one PR: a first-class executor service identity, an
owner-driven grant that gives it WRITE on a space, revocation, and the
`executorConfig` space doc that records opt-in.

**Read first:** `packages/background-piece-service/src/main.ts` ~96
(service identity from env — the precedent);
`packages/memory/v2/server.ts` ~813+ (ACL enforcement: OWNER/WRITE/READ
per DID); `docs/specs/toolshed-access-control.md`;
README §5.B.7 (executor principal; endorsement atom is NOT this WO — it
lands with Phase 2 and needs its own small spec, G1's atom half).

**Steps:**

1. Mint/configure the executor identity exactly like bps does (env
   `IDENTITY`-derived signer); expose its DID via a small module in the
   executor service package so tests can reference it.
2. Grant flow: a `cf` CLI command (e.g. `cf space executor enable
   <space>`) run by an OWNER session that (a) adds the executor DID with
   WRITE to the space ACL, (b) writes the `executorConfig` doc
   `{ enabled: true, derivedAuthority: "client", epoch: <seq> }`.
   Disable reverses both (ACL removal + `enabled: false`, epoch bump).
3. Server enforcement already exists (ACL check on transact); add a
   focused test that the executor DID can transact after enable and is
   rejected after disable.

**Success criteria:**

- [ ] `packages/memory` (or toolshed route test): executor DID transact →
      rejected before grant, accepted after, rejected after revoke; a
      commit in flight across revocation fails cleanly (no partial
      apply).
- [ ] `executorConfig` doc round-trips through a normal cell read (it is
      an ordinary doc; no new storage surface).
- [ ] CLI: enable → disable → enable leaves exactly one ACL entry and
      `epoch` strictly increasing (idempotency).
- [ ] Non-owner session cannot enable (authorization test).

**Review checklist:** the grant writes must be auditable (they are
ordinary commits by the owner session — verify no direct-DB mutation
path was added); revocation must not strand the executor mid-settle in a
crash loop (its commit failures must be terminal-permanent, not retried
forever — check the rejection is classified permanent, see the
permanent-rejection taxonomy from scheduler E0).

---

### W0.5 — In-process provider, stage 1 (loopback against a live Server)

**Depends on:** nothing. **Unblocks:** W0.6.
**Deliverable:** one PR: construct a StorageManager/provider against an
EXISTING `MemoryV2Server.Server` instance in-process (today `emulate()`
always builds its own).

**Read first:** `packages/runner/src/storage/v2-emulate.ts` (~36:
`EmulatedStorageManager` holds a `#serverFactory`);
`packages/memory/v2/client.ts` ~1299 (`loopback(server)` transport);
`packages/runner/src/storage/cache.deno.ts` ~20 (how emulate is reached).

**Steps:**

1. Add `StorageManager.inProcess(server, options)` (or an
   `emulate({ server })` overload — pick whichever fits the existing
   factory shape best) that uses `loopback(existingServer)` instead of a
   fresh server.
2. Find the storage conformance tests that currently run under
   `emulate()` (grep `StorageManager.emulate(` in `packages/runner/test`)
   and parameterize a representative subset to also run under
   `inProcess` with a shared server.

**Success criteria:**

- [ ] Two runtimes (in Deno Workers — realm rule!) against ONE shared
      in-process server see each other's committed writes (loopback
      two-runtime test; the harness recipe exists — see
      `multi-runtime-harness.ts`).
- [ ] The parameterized conformance subset passes identically under
      `emulate` and `inProcess`.
- [ ] No behavior change for existing `emulate()` callers (test suite
      untouched and green).

**Review checklist:** the worker-realm rule — reject any test that
constructs two runtimes in one realm; check the shared server's lifetime
is owned outside both runtimes (dispose order test).

---

### W0.6 — In-process provider, stage 2 (engine-direct, no sessions)

**Depends on:** W0.5. **Unblocks:** W1.1.
**Deliverable:** one PR: an executor-grade provider that (a) commits via
the engine directly, (b) reads via the engine read path, (c) receives
per-space invalidations from a commit-stream callback instead of
`session.watch` — plus the worker-boundary channel variant.

**Read first:** `packages/memory/v2/server.ts`: `Engine.applyCommit` call
sites (~950, ~1031, ~1628), `markSpaceDirty` (~1051), the read pool
(`#readPool`, ~711), and the session refresh loop you are bypassing
(~2155–2466 — understand what you are NOT going through);
`packages/runner/src/storage/v2.ts` (`Provider`, ~1074) and the
scheduler's storage-notification entry (search
`processPullStorageNotification` in `packages/runner/src`).

**Steps:**

1. Server API: `server.onSpaceCommit(space, cb)` — invoked after
   `applyCommit` success with `{ seq, changedIds }` (the same data
   `markSpaceDirty` receives). Synchronous registration, idempotent
   unregister; document that callbacks must not throw (wrap + log).
2. Provider: implement `IStorageProviderWithReplica` whose replica pulls
   docs through the engine read path on demand and applies commit-stream
   notifications into the existing notification entry the scheduler
   already consumes. Commits go to `applyCommit` with the executor
   session identity (W0.4) — reuse the commit-validation path, do NOT
   bypass conflict detection.
3. Worker variant: the engine lives on the host thread; the executor
   runtime lives in a Deno Worker. Bridge with a `MessageChannel`:
   requests (read/commit) as structured-clone messages; invalidations
   pushed host→worker. Batch reads (the compile-wedge lesson: long
   MessageChannel chains starve timers — keep the protocol
   request/response, no polling loops).
4. Equivalence guard: a differential test running one fixture pattern to
   settle under (a) the stage-1 loopback provider and (b) the
   engine-direct provider, then byte-comparing all docs in the space
   (state-inspector dump) and the observation rows (if W0.1 landed).

**Success criteria:**

- [ ] Differential test green (byte-identical docs under both providers).
- [ ] Zero sessions: assert the server has no session/watch registered
      for the executor connection while the fixture runs (inspect server
      session count — expose a test-only accessor if needed).
- [ ] Invalidation correctness: an external commit (via a second,
      ordinary client session) invalidates and re-settles the executor
      runtime (value observed updated) without any watch.
- [ ] Worker variant: same fixture green with the runtime in a Worker;
      no cross-realm construction.
- [ ] Conflict path: two writers (executor + client) racing one doc →
      executor sees a normal conflict/retry, not corruption (reuse an
      existing conflict test shape).

**Review checklist:** confirm commits flow through the SAME
`applyCommit` validation as remote commits (look for any "trusted"
shortcut and reject it); callback registration must be per-space and
cleaned up on provider dispose (leak test); no timer-based polling in the
worker bridge.

---

### W0.7 — `session.interest.set` + doc-set feed (flagged)

**Depends on:** nothing. **Unblocks:** W1.1 discovery; Phase 3.
**Deliverable:** one PR: a flagged alternative to `session.watch` graph
queries — the session declares interest; the server fans out changed docs
by set-membership. v0 grain: whole-space (`pieces: "*"`) only;
piece-granular closures arrive in Phase 1 when the executor can export
them.

**Read first:** `packages/memory/v2/server.ts` — the watch/refresh path
you are adding an alternative to: `markSpaceDirty` (~2320) → refresh
loop (~2466) → `refreshDirty` (~649) → `syncSessionForConnection`
(~2155) → `refreshTrackedGraph` (~2223); catch-up `fromSeq/toSeq`
(~2187/2269); `docs/specs/memory-v2/04-protocol.md` §4.1.1 (message
envelope conventions).

**Steps:**

1. Protocol: add `session.interest.set { space, pieces: "*" }` (accept
   only `"*"` in v0; reject arrays with a clear error so the field can
   grow). A session in interest mode for a space suppresses graph-query
   refresh for that space and instead receives `SessionSync` upserts for
   ALL changed docs in the space (compute from changed ids directly; no
   graph re-evaluation).
2. Catch-up: reuse the existing `seenSeq`→head resume path for interest
   sessions (it already iterates commits by seq).
3. Client: behind `CF_INTEREST_FEED`, the shell/runtime sends
   `interest.set` for each opened space instead of the per-piece watch
   registration (find where `session.watch.set` is issued in
   `packages/runner/src/storage/v2.ts` / the shell boot path and branch
   there). Everything downstream of received upserts is unchanged.
4. Latency instrumentation: count and time server-side per-commit fan-out
   work in both modes (a counter the perf test can read; OTel if #4448
   has landed by then — check).

**Success criteria:**

- [ ] Two-client parity test: clients A (watch mode) and B (interest
      mode) on one space; a third session commits; A and B converge to
      identical replicas (compare a sampled doc set), B's delivery
      latency ≤ A's (coarse assert: within 2× of the 5ms refresh tick).
- [ ] Reconnect: interest-mode session disconnects, misses N commits,
      reconnects with `seenSeq` → receives exactly the missed changes
      (no duplicates: assert upsert count).
- [ ] Server does NOT run `refreshTrackedGraph` for interest-mode
      sessions (call counter assert).
- [ ] Flag off: zero protocol traffic difference (snapshot the message
      log of a fixture run, compare to main).
- [ ] Old server + flagged client: client falls back to watch mode
      gracefully when the server rejects the unknown message (version
      tolerance test — the stale-server skew trap is real).
- [ ] Ordering: upserts for a space are delivered and applied in
      nondecreasing seq order under rapid commits (assert the applied
      seq sequence is sorted). The overlay drop rule (W2.3, README
      §5.B.4) depends on this guarantee.

**Review checklist:** interest mode must not leak docs the session's ACL
would not allow (the watch path had per-session scoping — verify the
interest path enforces the same reader checks; write the adversarial
test: user partitions of OTHER users must not appear in the feed).
This is the WO where reader isolation can silently break — treat that
last criterion as blocking.

---

## 3. Phase 1 — Approach A: server catch-up executor

Phase exit criteria (all must hold before Phase 2 starts):

- E1.a A cold, opted-in space catches up within 10s of a source commit
  with no client connected (W1.3 test).
- E1.b Zero double-fired async requests in the 3-tab multi-runtime test
  (W1.2 test).
- E1.c bps regression suite green under the reactive mode (W1.4).
- E1.d Executor-served space feed latency ≈ watch latency (W0.7 metric
  within 2×).

### W1.1 — Executor pool: reactive worker-per-space service

**Depends on:** W0.4, W0.5 (W0.6 preferred), W0.1 (for hibernate/resume).
**Deliverable:** one PR (large; may split into worker-lifecycle +
demand-loop): `background-piece-service` gains `EXECUTOR_MODE=reactive`
— per-space Deno Worker running a runtime on the in-process provider,
kept current by pull-on-invalidation, hibernating when idle.

**Read first:** the whole of
`packages/background-piece-service/src/` — especially `service.ts` (~31:
BGPieceEntry discovery via `.sink()`; ~107: SpaceManager per space),
`space-manager.ts` (~40: `rerunIntervalMs ?? 60000` — the polling you are
replacing), `worker-controller.ts` (~78: `new Worker(...)`),
`worker-ipc.ts`, `worker.ts`; `packages/runner/src/cell.ts` ~1032
(`Cell.pull()` — ephemeral demand root, settles to closure);
README §6.1–§6.5.

**Steps:**

1. Mode flag `EXECUTOR_MODE=reactive` (env, default absent = today's
   polling behavior untouched).
2. Registration: v1 discovery = the existing BG registry cell UNION
   spaces with `executorConfig.enabled` (W0.4). Per space, the interested
   piece set = registry entries for that space (client-driven interest
   arrives in W1.3+/Phase 3).
3. Space worker: construct runtime with `persistSchedulerState: true`,
   `storageConnection: "in-process"` (worker-bridge from W0.6), the
   executor signer, and `rehydrateFromStorage` subscriptions.
4. Demand loop (the core): on each `onSpaceCommit` batch → for each
   interested piece → `resultCell.pull()` → await settle → await
   `runtime.settled()` (async builtins). Explicitly DO NOT register a
   standing schema-less sink over piece state (this exact shape caused a
   ~270× re-run amplification; reviewers will reject it).
5. Hibernation: idle timer (no commits, no in-flight async for N min,
   default 10 to match the existing worker timeout) → `runtime.settled()`
   → per-space storage teardown (`StorageManager.closeSpace` ships with
   PR #4115; if unmerged when you get here, implement teardown against
   the StorageManager seam and say so in the PR) → terminate worker.
   Drain protocol: record the worker's last-settled seq; mark the space
   *draining* in the pool until the worker exits; wake decisions treat
   draining spaces as having no worker and compare incoming commits
   against last-settled seq (W1.3), so nothing lands unseen between
   settle and terminate. Wake = W1.3 (until then, workers for registered
   spaces stay up).
6. Crash isolation: worker error → report, restart with backoff, other
   spaces unaffected (worker-controller has error events already —
   extend).

**Success criteria:**

- [ ] Integration test (in bps package, in-process server + cf-CLI-style
      seeding): opted-in space with a fixture pattern whose lift derives
      `out = f(in)`; commit `in` via an ordinary client session; with NO
      client-side execution, `out` is correct in the store within 10s.
- [ ] Async: fixture with a `fetchJson` against a local stub — executor
      performs the fetch and writes the result; stub sees exactly 1
      request.
- [ ] Hibernate/resume: after idle timeout, the worker is gone (assert
      pool size); a later commit + manual `ensureSpace` call resumes and
      catches up using rehydration — and the fixture's lift-invocation
      counter shows only the stale subset re-ran.
- [ ] Two spaces, two workers; `Worker.terminate()` one mid-settle →
      other space unaffected; killed space recovers on restart with
      correct results (no torn state — commits are transactional).
- [ ] Mode off: bps behaves byte-identically to main (its existing tests
      unmodified and green).
- [ ] No standing schema-less sink anywhere in the new demand path
      (grep-level review criterion; also assert re-run counts stay flat
      when an unrelated doc in the space changes — the amplification
      canary).
- [ ] Drain race: a commit landing between `settled()` and worker
      terminate triggers a respawn that catches up (force the window
      with a test hook/delay; assert final derived state correct and
      exactly one respawn).

**Review checklist:** the demand loop must be pull-based
(`pull()`-per-wake) as specified; check `settled()` (not `idle()`) gates
hibernation; check the worker bridge does not poll; check executor
commits carry the executor identity (sample a commit's session in the
store); verify the amplification canary test is real (unrelated-doc
write → zero pulls).

---

### W1.2 — Async executor priority

**Depends on:** W1.1.
**Deliverable:** one PR: when a space has a live executor, async builtins
fire only there; clients defer.

**Read first:** `packages/runner/src/builtins/fetch-utils.ts` ~90–151
(`tryClaimMutex`: claim record + `lastActivity` + timeouts: 5s fetch /
5min llm-dialog), ~157–180 (`tryWriteResult` guard);
`packages/runner/src/builtins/fetch.ts` ~473–500 (claim usage);
README §5.B.5 (the eventual passive mode is Phase 2 — this WO is only
priority, not prohibition).

**Steps:**

1. Executor liveness signal: the space worker maintains a heartbeat doc
   (`executorHeartbeat`, updated every ~5s while awake; ordinary doc, no
   new surfaces).
2. Claim precedence: `tryClaimMutex` gains a role — clients, before
   claiming, read the heartbeat; if fresh (< 3× interval), do not claim
   (leave pending rendering as-is). The executor claims unconditionally
   and may take over a stale client claim immediately.
3. Timeout fallback unchanged: heartbeat stale → clients behave exactly
   as today.

**Success criteria:**

- [ ] Multi-runtime test (3 client workers + executor, shared in-process
      server, stub fetch endpoint): stub receives exactly 1 request; its
      auth/identity marker shows the executor session.
- [ ] Kill the executor mid-request: heartbeat goes stale; a client
      claims after the existing timeout and completes; result correct
      (the fixture asserts final value, and total requests ≤ 2).
- [ ] No executor (heartbeat absent): behavior identical to main (run an
      existing cross-tab mutex test unmodified).
- [ ] Clock skew guard: heartbeat freshness uses server seq/time
      consistently (pin whichever the claim records already use —
      `lastActivity` convention — do not introduce a second clock).

**Review checklist:** the client defer path must not spin (no tight
retry loop while heartbeat fresh — it should simply not claim and rely
on normal invalidation); check llm-dialog's 5-minute timeout is
respected (don't let executor takeover break a live client streaming
session — takeover only on stale claims).

---

### W1.3 — Wake-on-commit

**Depends on:** W0.2, W1.1.
**Deliverable:** one PR: hibernated spaces wake when a commit makes an
interested piece stale; irrelevant commits don't wake anything.

**Steps:**

1. Host-side hook: on `onSpaceCommit` for a space with no live worker
   (including *draining* ones — W1.1's drain protocol), run
   `staleReadersFor(space, changedIds, seq)` (W0.2) filtered to the
   registered piece set; non-empty → `ensureSpace(space)` (W1.1) and
   hand the worker the stale piece list for targeted pulls. For a
   draining space, additionally wake when `seq >` the recorded
   last-settled seq even before the readers query (cheap guard against
   losing the race).
2. Debounce: batch wake decisions per space per refresh tick (reuse the
   5ms dirty-batch cadence; do not add a new timer).
3. Metrics: counters for wakes, suppressed (no-reader) commits, catch-up
   duration.

**Success criteria:**

- [ ] Integration: registered space, worker hibernated; external commit
      to a doc a piece reads → worker spawns, only stale actions re-run
      (invocation counter), derived docs correct, worker re-hibernates.
- [ ] Negative: commit to a doc NO piece reads → no worker spawn
      (counter asserts suppression), and the readers-index query is the
      only work done.
- [ ] Burst: 50 rapid commits → at most a handful of wake evaluations
      (batching assert), one worker spawn.

**Review checklist:** the no-reader suppression is the point of W0.2 —
reject implementations that spin the worker up to "check". Verify the
stale piece list actually narrows the pulls (not pull-everything).

---

### W1.4 — Fold bps registry into interest; deprecation path

**Depends on:** W1.1.
**Deliverable:** one PR: BG piece entries become executor interest
registrations; the 60s polling updater is off for reactive-mode spaces;
docs updated.

**Success criteria:**

- [ ] Existing bps end-to-end test scenarios pass in reactive mode (port
      the suite; list any intentionally-changed semantics in the PR).
- [ ] A space in reactive mode never runs the polling rerun loop
      (`rerunIntervalMs` timer not scheduled — assert via test hook).
- [ ] Rollback: flipping `EXECUTOR_MODE` off restores polling behavior
      without data migration.

---

## 4. Phase 2 — Approach B: derived-authority split (per-space flag)

Phase exit criteria:

- E2.a On flagged spaces, client commits contain zero space-scoped
  derived writes (wire assertion in CI).
- E2.b Multi-client perf fixtures (lunch-poll, group-chat) on flagged
  spaces: derived write-write conflicts ≈ 0; per-client action volume ≈
  single-client baseline (measured, with NEW_PERF_BASELINE process for
  accepted shifts).
- E2.c Divergence counter ≈ 0 on deterministic fixtures; nonzero only on
  the rigged-divergence test.
- E2.d Flag-off spaces byte-identical to main behavior (differential CI
  job).

Deliberately NOT a Phase-2 WO: the executor-computed endorsement atom
(G1's second half). It needs a small CFC-owned spec first
(`writeAuthorizedBy`/integrity machinery); B's flip does not depend on
it. Coordinate with CFC owners when Phase 2 starts so the spec is ready
by Phase 4.

### W2.1 — Ownership bit + client honoring skeleton

**Depends on:** W0.4.
**Deliverable:** one PR: `executorConfig.derivedAuthority:
"client" | "executor"` with sticky epoch semantics; client runtime reads
it at space open, subscribes to changes, and exposes
`spaceDerivedAuthority(space)` to the storage layer. No routing yet.

**Success criteria:**

- [ ] Flip test: change `derivedAuthority` → connected clients observe
      the change (assert the exposed getter flips) within one feed tick;
      epoch increases monotonically; a stale-epoch write of the config
      doc is rejected by normal conflict rules.
- [ ] Default: spaces without the doc report `"client"` (today's mode).

### W2.2 — Write-class routing + speculative overlay

**Depends on:** W2.1, W0.3.
**Deliverable:** one PR (the core of B; expect it to be the
most-reviewed): on `derivedAuthority: "executor"` spaces, transactions
whose `TxProvenance.action.kind` is `computation`/materializer-`effect`
AND whose writes target space-scoped (unscoped) addresses apply to a
local overlay and are never enqueued upstream; handler/setup/UI-binding
txs commit exactly as today.

**Read first:** README §5.B.1 (the routing table — implement it
literally), §5.B.3 (handler semantics: NO new read restrictions — the
overlay participates in local reads exactly like today's optimistic
apply), §5.B.6 (scoped writes are EXEMPT from routing — they stay
client-committed in this phase);
`packages/runner/src/storage/v2.ts` (`Provider` commit/apply path) and
`packages/runner/src/storage/interface.ts` (`ISpaceReplica`, ~1367).

**Steps:**

1. Overlay structure on the replica: per doc,
   `{ value, basis, generation }` layered above confirmed state for all
   local reads; `basis` = the latest of the client's OWN source commits
   the recompute consumed (its localSeq until confirmation, then the
   assigned seq — README §5.B.4 rule 1). Dropped en masse per doc on
   watermark (W2.3), on basis-commit rejection (§5.B.4 rule 4), or on
   authority flip.
2. Routing decision at commit-enqueue time, from
   `tx.provenance.action.kind` + target address scope + the W2.1 getter.
   Scoped-address writes (user/session) bypass routing (commit as
   today) even from computation txs.
3. Instrumentation: per-space counters {overlayWrites, committedSource,
   committedScoped, droppedOverlay, divergences}.
4. Safety valve: authority flip back to `"client"` → flush semantics:
   discard overlay, resume committing derived writes from the next
   settle (document why discard is safe: server state is authoritative
   and clients recompute).

**Success criteria:**

- [ ] Wire assertion: on a flagged space, run a fixture with handler +
      lifts; capture all ClientCommits (test transport hook): zero
      operations target unscoped derived docs from computation txs;
      handler writes present and unchanged.
- [ ] Local reactivity: with NO server executor running, the client UI
      value (read through the normal cell read path) still updates
      immediately after a source write (overlay serves it) — this pins
      "speculation works offline".
- [ ] Scoped exemption: PerUser/PerSession derived fixture → those
      writes still commit (wire assert), and user-partition contents
      match main behavior.
- [ ] Parity: flag off → a differential run of the fixture produces
      byte-identical commits to main (record/compare op streams).
- [ ] Authority flip mid-session: no crash, overlay discarded, next
      settle recommits derived state, store converges (end-state equals
      a from-scratch run).
- [ ] Handler-read semantics unchanged: an existing handler
      conflict/retry test passes unmodified on a flagged space with a
      live executor (two-runtime test: stale handler read → conflict →
      retry → success).

**Review checklist:** the routing must key on the W0.3 envelope, not on
heuristics (doc-id patterns, schema sniffing — reject); the overlay must
be per-space and fully discardable (no partial-drop states); confirm
setup/seed txs route as source (structural provenance markers must keep
passing CFC gates — run a setup-heavy CFC test); confirm no path
commits an overlay value "for convenience".

### W2.3 — Watermark surfacing + overlay reconciliation

**Depends on:** W2.2, W0.1.
**Deliverable:** one PR: executor derived commits carry
`observedAtSeq` (envelope field → persisted on the commit → visible in
the feed); clients drop overlay per README §5.B.4 rules; divergence
counter live.

**Success criteria:**

- [ ] End-to-end two-runtime test (client + executor, in-process
      server): client source write (assigned seq S) → overlay shows
      predicted derived value → executor recomputes and commits with
      watermark W ≥ S → client drops overlay, confirmed value shown;
      assert the overlay is GONE (not just equal).
- [ ] Laggard: executor commit with W < S → overlay retained (assert),
      then dropped when a later W ≥ S arrives.
- [ ] Divergence: rig the executor fixture to compute a different value
      → server wins silently, divergence counter = 1, no error surfaced
      to the pattern.
- [ ] Watermark integrity: W equals the max input seq the producing
      action consumed (assert against the observation row from W0.1 —
      they must be the same number, same source).
- [ ] Multi-commit basis: two rapid source writes with assigned seqs
      S1 < S2; overlay reflects both (basis S2); an executor derived
      commit with S1 ≤ W < S2 does NOT drop the overlay, W ≥ S2 does
      (pins §5.B.4 rules 1–3).
- [ ] Rejected basis: a source commit that conflicts and retries →
      overlay generations based on it are discarded, post-retry state
      converges to the executor's recompute (pins §5.B.4 rule 4).

**Review checklist:** the drop rule must compare against the
CONFIRMATION-assigned seq of the client's own source commit (not
localSeq); check overlay retention under out-of-order feed delivery
(seq-ordered application is a memory-v2 guarantee — verify the client
applies in order).

### W2.4 — Builtin passive mode on flagged spaces

**Depends on:** W2.1, W1.2.
**Deliverable:** one PR: on `derivedAuthority: "executor"` spaces,
client builtin actions never issue network work regardless of heartbeat
(upgrade of W1.2's priority into prohibition); they materialize
pending/result purely from cells.

**Success criteria:**

- [ ] Multi-runtime: stub endpoint sees requests only from the executor
      even when the executor heartbeat is briefly stale (clients wait;
      assert zero client requests over a 2× timeout window).
- [ ] UX continuity: client renders `pending` → `result` transitions
      driven by the feed (existing builtin fixture asserts the cell
      sequence).
- [ ] Unflagged spaces keep W1.2 behavior (fallback test unmodified).
- [ ] Executor absent AND space flagged: requests stay pending; a
      loud diagnostic is logged once (not per retry); flipping authority
      back to `"client"` releases the work.

**Review checklist:** the "executor down on a flagged space" state is a
real operational mode — verify the diagnostic + the flip-back release
path with a test, and that nothing busy-waits.

### W2.5 — Executor demand-root scope exclusion

**Depends on:** W1.1.
**Deliverable:** one PR: the executor's per-piece pulls never demand
user/session-scoped subtrees (transitional carve-out; lifted in Phase 4).

**Read first:** scope brands on links (see
`packages/runner/test/link-utils.test.ts` and the scope-folding
history); README §5.B.6.

**Success criteria:**

- [ ] Fixture with space-scoped + PerUser derived state: executor
      catch-up updates the space-scoped docs and leaves ALL `user:`/
      `session:` partitions untouched (state-inspector assert: zero
      writes under any user partition by the executor session, and —
      critically — zero docs created under the EXECUTOR's own user
      partition: pulling a scoped cell as the executor identity would
      materialize an executor-partition copy; that must not happen).
- [ ] Client-side computation of the scoped values still works (its
      writes commit per W2.2 exemption).

**Review checklist:** the exclusion must live in the demand walk (what
gets pulled), not only in write filtering — the criterion about
executor-partition copies is the tell.

### W2.6 — Phase-2 measurement + flip runbook

**Depends on:** W2.2–W2.5.
**Deliverable:** one PR: perf fixtures (lunch-poll, group-chat
multi-user) runnable on a flagged space with the executor pool; a CI/
locally-runnable report of E2.a–E2.d; a short runbook section in this
folder for flagging a space on/off in staging.

**Success criteria:**

- [ ] The report emits: derived-conflict count, per-client action
      volume vs single-client baseline, divergence count, feed latency —
      with pass/fail against E2.a–E2.d thresholds.
- [ ] One staging space flipped on, exercised, flipped off, with store
      state verified consistent afterwards (runbook executed once;
      evidence linked).

---

## 5. Phases 3–5 — outline + entry criteria (do not start)

- **Phase 3 — subscriptions retired + projector boot.** Entry: Phase 1
  exit + W0.7 piece-granular interest (needs the executor to export
  per-piece read closures — design a small spec addendum first: closure
  export format, update cadence, cross-space handling per README §6.4).
  Projector boot additionally gates on the RI-branch VNode-doc
  consolidation landing on main (it is NOT on main today).
- **Phase 4 — scoped execution.** Entry: README §10.4 decided
  (delegation shape: standing grant vs session-minted tokens; sub-worker
  vs per-user demand roots) → G3 spec written and reviewed; G16 (RI
  scoped-output interpretation) if RI is the executor engine by then;
  executor endorsement atom spec (G1's second half) — coordinate with
  CFC owners, it touches `writeAuthorizedBy`/integrity machinery.
- **Phase 5 — dual handler execution.** Entry: G13 envelope spec written
  (serialize trusted-event provenance; replay protection; verify path —
  precedent: `docs/specs/toolshed-access-control.md` request proofs) and
  README §10.1's default-flip trigger named. First implementation slice:
  `serialize: "server"` opt-in per handler.

---

## 6. Review-agent playbook (applies to every PR above)

1. **Map criteria to tests.** For each success criterion, find the test
   by name in the diff. If a criterion has no test, the PR is incomplete
   — regardless of how plausible the code looks. Ask for the red run of
   the headline test (link or transcript).
2. **Parity first.** Run/inspect the flag-off differential before
   reading the feature code. A parity break is an automatic
   request-changes.
3. **Known traps to grep for** (each has bitten this codebase):
   - schema-less/whole-state sinks or deep traversals in new demand or
     feed paths (re-run amplification);
   - a second runtime/Engine in one realm in tests (breaks verified
     identity);
   - `idle()` where `settled()` is needed around async builtins;
   - new timers/polling loops where an event/callback seam exists;
   - direct DB writes bypassing `applyCommit` (breaks transactionality,
     provenance stamping, and the readers index);
   - widening the CFC raw-surface exclusions in `cfc/prepare.ts`;
   - tests sharing `$TMPDIR` sqlite across repetitions;
   - default `:8000` servers in integration tests.
4. **Identity checks.** Any new write path: whose session signs it, and
   does the store show that session? Sample a commit in the test store.
5. **Reader isolation.** Any new read/feed path: write or demand the
   adversarial test (other users' `user:` partitions must not leak; the
   executor must not materialize scoped copies under its own identity).
6. **Failure modes are features.** Hibernate/crash/flip-back paths need
   tests, not comments. If a WO lists a rollback criterion, execute it.
7. **Scope discipline.** The WO's non-goals are binding: e.g. W1.2 must
   not implement prohibition (that is W2.4); W0.4 must not implement the
   endorsement atom (Phase 2/CFC spec). Flag scope creep even when the
   extra code is good.

## 7. Decisions this plan intentionally does not make

Tracked in README §10: dual-execution default trigger (§10.1), interest
granularity beyond `"*"` (§10.2), executor principal per deployment vs
per space (§10.3 — this plan assumes one principal per deployment, per
the README proposal), delegation shape (§10.4), executor pool placement
long-term (§10.5), projector-mode render path (§10.6).
