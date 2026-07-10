# Per-doc scheduler-state restore (F6c)

Status: Implemented behind the persistent-scheduler-state flag.
Scope: persistent-scheduler-state flag ON only (`getPersistentSchedulerStateConfig()`);
flag-off behavior is unchanged.
Companions: `docs/specs/persistent-scheduler-state.md` (durable model),
`README.md` §9 (v2 resume model). Follow-up CT from PR #4288.

## 1. Problem

Persistent scheduler state is restored by **root pieceId only**: `start()`
lists snapshots for `pieceId = ${scope}:${id}` of the root result cell
(`runner.ts loadSchedulerRehydrationSnapshots`) and hands the actionId-keyed
map to the root's `startCore`. Every dynamically-instantiated descendant —
sub-pattern nodes (`instantiatePatternNode`), map/filter/flatMap per-element
runs — starts through `run()`/`startWithTx()`, whose `RunnerRunOptions` carry
only the `awaitSyncBeforeInitialRun` boolean. The child's `startCore` then
synthesizes `schedulerRehydrationOptions(childCell, undefined, awaitSync)` —
snapshots hard-coded absent.

Three defect modes follow (all reproduced by
`packages/runner/test/reload-rehydration-map-children.test.ts`, the
two-manager loopback probe):

- **(a) Children re-run fresh.** When the collection coordinator re-runs on
  resume (e.g. it carries a durable dirty marker), each per-element child run
  reaches `startCore` and registers fresh-invalid. Probe: all three row lifts
  re-ran on resume while their persisted snapshots — keyed by their own
  pieceIds, with byte-identical restart-stable actionIds — sat **clean** and
  unused in the store. This is the racing/churn defect: first runs against
  possibly-cold data, optimistic instantiation commits, the picker-row
  alias-chain conflict.
- **(b) Children lose even the flag-off sync hold.** Under flag-ON,
  `schedulerRehydrationOptions` returns a snapshot-less `rehydrateFromStorage`
  and **no** `awaitSyncBeforeInitialRun`; `register()`'s branch is an else-if
  (`snapshotsByActionId ? apply : awaitSyncBeforeInitialRun ? hold : nothing`),
  so the child gets **neither** the snapshot branch nor the hold. Flag-ON is
  strictly worse for children than flag-off. (The comment in
  `builtins/map.ts` claiming the resumed reconcile "is itself sync-gated" is
  false in this world.)
- **(c) Clean coordinators strand rows entirely.** If the coordinator's
  snapshot rehydrates clean, its reconcile never runs, so per-element child
  pieces are **never instantiated**: their actions are unregistered, their
  reactivity is dead (an element-field write re-derives nothing) until some
  structural list write happens to dirty the coordinator. Rehydrating a
  child-starting action "clean" is semantically wrong: its durable outputs are
  valid, but its live closure side-effect — starting the children — has not
  been re-established.

## 2. The doc→deriver mapping

The restore key is the **doc**: `pieceId` *is* the derived doc
(`${scope}:${id}` of the piece's result cell). The invariant — each doc is
derived by exactly one piece — already holds by construction:

- **Static sub-pattern nodes**: the child result doc is minted from the cause
  `{ resultFor: <resolved output-redirect spot> }` (`instantiatePatternNode`),
  a stable, position-derived identity. One node owns one output spot; the same
  doc id re-derives on every resume.
- **Collection elements**: the per-element doc is minted from
  `{ map: <container>, elementKey }` where the container is
  `{ map: parentEntity, outputSpot }` and `elementKey` is the element's link
  identity (+ occurrence). One element occurrence, one doc. (Inline-value
  elements key positionally — an accepted identity trade-off documented in
  `builtins/map.ts`; a shifted inline element re-derives as a fresh doc and
  simply misses rehydration, degrading per node.)
- **Persist side**: under flag-ON every piece's `startCore` — root or child,
  fresh or resumed — stamps `rehydrateFromStorage` with its own doc-derived
  pieceId, so `register()` annotates every pattern-node and builtin action
  with the right identity and observations land under the doc that action
  derives. Verified empirically: per-element lifts persist under their own
  pieceIds with restart-stable actionIds
  (`cf:module/<hash>:<symbol>:<instanceKey>`, instance keys folding the
  piece-scoped doc links).

What must be tightened so the mapping is *reliable*:

- **Persist only doc-keyed observations.** Actions registered without
  `rehydrateFromStorage` (the `cell.ts` pull effect, `wish.ts` hashtag
  resolver, test sinks) currently persist under the
  `patternName:moduleName` / `action:<actionId>` fallback
  (`schedulerObservationPieceId`). Those rows are unfindable by any doc-keyed
  restore and unrehydratable by construction (their registrations never carry
  identity). `attachSchedulerActionObservation` skips persisting when
  `schedulerObservationIdentity` is absent; the fallback function is deleted.
  Every remaining row then satisfies the invariant: `pieceId` names the doc
  its actions derive.
- The `sendToBindings === false` variant (output binding links an existing
  non-redirect cell) keeps the invariant: the deriver is still the one
  instantiating node; the doc id comes from the stable binding rather than a
  `resultFor` mint.

No *reverse* (deriver→docs) index is required for restore: derivation is
re-walked top-down at resume (parents instantiate children), so each piece
knows its own doc locally at registration time. A persisted parent edge
("optional parent action id for dynamic child graphs",
`persistent-scheduler-state.md` §Action Identity) remains the future lever
for subtree GC and demand-targeted rehydration, not a dependency of this fix.

## 3. Design

Three legs. The guiding constraint is v2 §9.2: resume stays a phase that
completes before scheduling — v1's per-action async lookup apparatus
(tokens, superseded checks, per-action timeouts) stays dead.

### 3.1 Load once per space, share with the whole boot

`loadSchedulerRehydrationSnapshots` drops the `pieceId` filter and lists the
space: `{ ownerSpace, processGeneration: 0 }`, cursor-paginated. The engine
already supports this — every filter in `SchedulerActionSnapshotQuery` is
optional (`engine.ts listSchedulerActionSnapshots`), and the store is
per-space SQLite, so the blast radius is one space's rows. The result is
bucketed **per piece**:

```
Map<pieceId, Map<actionId, PersistedSchedulerObservationSnapshot>>
```

The root's own bucket feeds `startCore` exactly as today. The full per-piece
map is retained on the runner as a per-space **boot rehydration cache**:

- single-flight per space (concurrent `start()`s share one listing),
- replaced by the next top-level resume load for that space,
- cleared on runner dispose,
- never consulted outside resume intent (§3.2), so post-boot staleness is
  inert by construction.

Listing failure keeps today's semantics: degrade the whole boot to
resume-fresh (undefined map, no cache entry).

### 3.2 Children consume the cache synchronously at registration

`schedulerRehydrationOptions(resultCell, snapshotsByActionId, awaitSync)`
under flag-ON becomes:

- `snapshots = snapshotsByActionId ?? (awaitSync ? cache[space]?.byPiece[pieceId] : undefined)` —
  the child's own bucket, looked up by the doc it derives;
- emits `rehydrateFromStorage { space, pieceId, processGeneration, awaitSync?, snapshotsByActionId? }`
  **and**, when `awaitSync` (resume intent), `awaitSyncBeforeInitialRun { space }`.

`register()` decouples the two branches: apply snapshots when present
(`applyPreloadedInitialActionRehydration` returns whether the action actually
rehydrated), and hold-until-synced when the action did **not** rehydrate and
resume intent is set. That single change fixes (b) — a child (or a root
action whose snapshot misses/mismatches) degrades to the same synced-hold
fresh run the flag-off path gets — and makes per-action misses uniformly
safe (the hold releases immediately when the space is already synced).

No signatures change: the resume-intent boolean already reaches every child
`startCore` (`instantiatePatternNode` → `run(…, { awaitSyncBeforeInitialRun:
defersInitialRunUntilSynced(...) })`; map/filter/flatMap →
`awaitSyncBeforeInitialRun: elementAwaitSync`). Children register in resume
mode inside the same instantiation transaction — rehydration apply is
tx-free, in-memory index restoration.

### 3.3 Child-starting coordinators always run on resume

A builtin whose action run *starts child runs* (map, filter, flatMap — audit
any `runner.run` caller under `builtins/`) declares it in its
`RawBuiltinResult`: `resumeMode: "always-run"`. For such actions `register()`
skips the snapshot-apply branch (identity is still stamped; the hold still
applies), so the coordinator schedules its initial reconcile after the sync
hold releases. This fixes (c): the reconcile re-attaches every row —
`elementRuns` is rebuilt, per-element `startCore`s fire with resume intent,
and the rows themselves rehydrate via §3.2 instead of re-running.

Cost: one reconcile run per collection per resume (its writes are
value-identical, so downstream scheduling stays quiet per I3/I5) plus the
per-row instantiation writes — strictly less than today's world (a), which
pays all of that *plus* every row's op computation. "Re-attach rows without
running the reconcile" (rebuilding `elementRuns` from the persisted container
inside the builtin body) is a compatible future optimization; it does not
change this contract, only who performs the attach.

The `builtins/map.ts` resume comment becomes true again and is updated to
say why the coordinator deliberately never rehydrates clean.

## 4. Degradation and edge cases

- **Per-node degrade (I7)**: cache miss, fingerprint mismatch, listing
  failure, or hold timeout → identity + hold-until-synced → fresh run. Never
  incorrect cleanliness; staleness accrued while down still arrives via the
  store's durable dirty/stale markers (`scheduler_action_state`), which the
  listing already joins per row.
- **Cross-space children**: their observations live in the child space's
  store; the root boot lists only the root space. They keep today's behavior
  (hold + fresh). Extension: a lazy per-space cache fill on first cross-space
  child, explicitly out of scope here.
- **navigateTo-elevated children**: a child later started as its own root
  lists by its own pieceId — space-wide listing finds its rows regardless of
  which boot persisted them (a subtree-scoped listing would not).
- **Live-created children** (new rows mid-session, post-resume reconciles):
  no resume intent → no cache lookup → fresh, as today. The map's
  `resumeBatchAwaitSync` latch already scopes intent to the first non-empty
  resume batch.
- **Anonymous actions** (`anon-<n>` ids: no provenance hash, no name): not
  restart-stable, never match, degrade per node. Unchanged.
- **Effects**: session-scoped effects (sinks, pull) re-register fresh by
  design; with the §2 persist tightening they no longer pollute the store.
- **Reader-isolated rows** (`incremental-observation-adoption.md` C6): the
  store keeps one row per actionId, but a shared derivation over
  user/session-scope docs computes DIFFERENT data per reader, and each new
  observation clears the shared dirty markers — so the last writer's clean
  row must not rehydrate another reader's copy. The server's boot-listing
  response drops rows touching user-scope addresses unless the row's
  persisted writer session key carries the listing session's principal, and
  drops session-scope-touching rows always (a reloaded runtime is a new
  session). Affected actions degrade per node: fresh run over the reader's
  own rows.

## 5. Store cost and retention

No schema or protocol change. A resumed boot now reads the space's whole
snapshot set once instead of one piece's: rows ≈ Σ live actions per piece
(UPSERT-keyed; `scheduler_observation` history is deduped by payload). There
is **no GC yet** (spec Phase 7), so long-lived spaces accumulate rows for
dead pieces and the space listing pays for them; the parent-edge column is
the designated future fix (subtree listing + subtree GC), tracked in
`persistent-scheduler-state.md` open questions. Page size stays 500/1000;
the boot load is paginated and off the hot path (parallel to the pre-sync).

## 6. Spec deltas

- `persistent-scheduler-state.md` › Required Query Support: the bulk listing
  is space-scoped ("optionally piece id"); add a "Child piece rehydration"
  note under the Rehydration Algorithm: resume restores per **piece doc**,
  parents re-attach children, child-starting coordinators never rehydrate
  clean; persist requires doc-keyed identity (no fallback rows).
- `README.md` §9.2: "resume is a piece-level phase" → the phase covers the
  resumed piece **tree**: one space listing feeds every descendant's
  registration; degraded nodes hold until synced instead of racing.

## 7. Acceptance and tests

- `packages/runner/test/reload-rehydration-map-children.test.ts` (red-green,
  loopback two-manager harness so session 1 can be fully disposed):
  - resume trace contains **zero** row-op runs (red today: 3 fresh lift runs)
    while `rehydrate/ok` covers the rows (≥ 3);
  - post-resume element-field write re-derives exactly that row (liveness —
    guards against the stranded-rows mode (c));
  - structural append reconciles and runs only the new row.
- `scheduler-observations.test.ts`: unit branches — `resumeMode:
  "always-run"` runs despite a matching snapshot (with a rehydrating
  control), identity-less actions persist no observation. The
  hold-when-not-rehydrated decoupling is asserted end-to-end by the
  map-children test rather than a timing-sensitive unit gate.
- `reload-rehydration.test.ts`: the asserted listing query shape becomes the
  space-scoped one.
- Reload churn: the ≤ 1 residual gate lives in the flag-OFF integration run,
  where fresh child first-runs are inherent (v1 reached 0 via its populate
  pass; v2 flag-off has no restore to lean on). A flag-ON churn assertion in
  `integration/reload/` (the `pattern-reload-integration-test` job) pins
  flag-ON at "never worse than flag-off". Measured: the rows rehydrate, but
  the always-run coordinator's first reconcile still reads one cold hop
  through the field-level alias chain, so the same coupled 1-conflict
  residual remains. It reaches zero when resume-time runners pre-warm their
  persisted read sets — an application of the incremental
  observation-adoption direction (see below), not of the boot listing.

## 7.1 Where this goes next: incremental adoption in ongoing work

Reload is the degenerate case. The same per-doc observations, delivered
**incrementally with memory subscriptions**, let a live client skip work
another client already did: when client A's action run commits (observation
attached to the commit), every subscriber receiving those doc writes can
adopt the observation for its own registered equivalent action — same
pieceId/actionId (restart- and runtime-stable, proven above), same
fingerprints, deterministic computation over the same shared docs — instead
of re-running it. Receivers keep running their local effects (rendering);
they stop re-deriving computations the writer already derived. This is the
recovery lever for the multi-user perf delta, and it is the direction the
per-piece deriver-attribution rigor (P2) explicitly does NOT gate: the
observation arrives WITH the doc write, so the client never needs to find
the deriver. Design: `incremental-observation-adoption.md`.

## 8. Alternatives rejected

- **Per-child lazy listing at child `startCore`** (one RPC per piece,
  register-then-apply-async): reintroduces exactly the v1 per-action
  rehydration apparatus v2 §9.2 deleted, adds a round-trip per descendant,
  and makes child registration racy again. Rejected.
- **Threading the snapshot map through run options and builtin params**:
  same data flow as the cache, but grows `RunnerRunOptions`, the
  `RawBuiltin` positional API, and every list builtin's signature; the
  out-of-band boolean stays required anyway (it is deliberately not hashed
  into result-cell causes). The cache + resume-intent gate achieves the same
  with no signature churn. Rejected.
- **Subtree enumeration via persisted parent edges**: right long-term shape
  for GC and demand-targeted rehydration, but requires schema + protocol +
  write-path changes now, and a subtree listing would miss
  navigateTo-elevated roots. Deferred, not needed for correctness.
- **Re-attach rows without running the coordinator**: rebuilds `elementRuns`
  and child runs from the persisted container inside the builtin body;
  avoids the reconcile run but duplicates reconcile logic against
  possibly-stale container state. Deferred as an optimization behind the
  same contract.
