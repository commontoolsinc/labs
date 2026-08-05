# v2 coverage: today's runtime, mapped

This document maps every behavior of today's runtime — the scheduler,
runner, built-ins, and their storage seams on main — to its place in
the v2 spec set, so that implementers discover nothing mid-build. Each
row names the mechanism as it exists today (file:line), the v2 section
that governs it, and a status: the GAP rows are the open decisions and
the CHANGED rows are the mechanisms that do not port as-is. It is a
live document: when a GAP is ruled or an anchor drifts, edit the row
in the same PR.

File references are relative to `packages/runner/src/` unless another
package is named; line numbers verified on main, 2026-08-02.

Status legend:

- **COVERED** — a v2 doc places the behavior; port as written there.
  Rows whose "port" is just "the SpaceServer hosts the same runtime"
  cite serving-loop.md §3 and carry no note.
- **CHANGED** — v2 places it, but the mechanism changes; the note says
  what changes and what deletes.
- **GAP** — no v2 doc places it. Each GAP note states the default the
  mapping recommends; a GAP whose row a phase touches must be ruled
  before that phase builds.
- **RULED** — a former GAP closed by an owner ruling; the note
  records the ruling and the v2 section that now carries it.

## 1. Summary tables

### 1a. Action taxonomy — what runs, and where

| # | behavior | today (anchor) | v2 doc § | status |
| --- | --- | --- | --- | --- |
| 1 | Pull computations (lift/computed): demand-driven, run when an effect's cone pulls them | `scheduler/work-oracle.ts:16-40`, node kinds `scheduler/node-record.ts:3` | serving-loop §3, §3b | COVERED |
| 2 | Eager actions (effects): always run when dirty; "once an effect, stays an effect" | registration `runner.ts:6208-6240`, promotion note `scheduler/node-record.ts:27-29` | serving-loop §3; split per §3.5 classes | CHANGED |
| 3 | Render effects (cell `sink`) and external subscribers | `cell.ts:2102-2129` | README §3.2 (client-side) | COVERED |
| 4 | Materializers: computations writing through captured Writable cells; idle-priority seeds | `scheduler/materializers.ts:18`, envelopes `runner.ts:5666-5681`, idle seeds `scheduler/work-oracle.ts:116-127` | none by name | GAP |
| 5 | One action run = one transaction; commit fired without await; resubscribe from the run's log | `scheduler/run.ts:346-428`, `run.ts:544-613` | serving-loop §3d (seal into wave) | CHANGED |
| 6 | Storage notification → trigger index → mark-invalid with recorded causes | `scheduler/invalidation.ts:79-221`, causes `invalidation.ts:241-294` | serving-loop §3 (dirtiness path) | COVERED |
| 7 | Self-echo suppression: own-commit-source and changeGroup skips | `scheduler/invalidation.ts:165-174`, `344-364` | serving-loop §3 (class+holder skip) | CHANGED |
| 8 | Settle loop: seeds, topological order, MAX_ITERS, pass budget, convergence backoff, idle escape valve | `scheduler/settle.ts:490-503`, `scheduler/execution.ts:242-318`, `scheduler/constants.ts:1-30` | serving-loop §3 (wave = run to idle; budget exhaustion) | COVERED |
| 9 | Per-action time gates: debounce, throttle, auto-debounce of slow effects, initial-run hold | `scheduler/gates.ts:24-463`, auto-debounce `gates.ts:123-154`, hold `gates.ts:46-57` | none by name | GAP |
| 10 | Wake shaping (timing side channels W3/W4/plan B): input-event and cell-flip token buckets | `scheduler/wake-shaping.ts:1-40`, `scheduler/invalidation.ts:56-77`, `scheduler/facade.ts:1354-1366` | none | GAP |
| 11 | Quiescence surfaces: `idle()`, `idleWithPendingCommits()`, `runtime.settled()/settledFor()` | `scheduler/facade.ts:1191-1301`, `runtime.ts:1197-1308` | serving-loop §3 (idle ends wave); testing §3 (watermark) | CHANGED |
| 12 | Scheduler runs off the render thread (worker on clients) | `scheduler/facade.ts:175` | speculation §Anchors | COVERED |
| 13 | Diagnostics: action stats, run/trigger traces, diagnosis, idempotency-check mode, breakpoints | `scheduler/diagnostics.ts`, `diagnosis.ts`, `facade.ts:1582-1817` | serving-loop §7 (counters are the required surface) | COVERED |

### 1b. Retry and failure machinery

| # | behavior | today (anchor) | v2 doc § | status |
| --- | --- | --- | --- | --- |
| 14 | `RetryImmediately`: abort + immediate re-run after `inSpace("name")` DID resolution | `scheduler/retry-immediately.ts:11`, `runner.ts:4933-4943`, event path `scheduler/events.ts:955-983` | protocol §2b (provisioning kept) | COVERED |
| 15 | Reactive stale-basis retry: off-budget re-queue on conflict / local inconsistency, `readyToRetry` catch-up | `scheduler/run.ts:122-214` | serving-loop §3d (mid-wave CAS drop) | CHANGED |
| 16 | Bounded retry for non-conflict reactive failures (MAX_RETRIES_FOR_REACTIVE = 10) | `scheduler/run.ts:239-253`, `scheduler/constants.ts:40` | serving-loop §3d (per-action failure isolation) | COVERED |
| 17 | Event-commit backpressure: capped exponential backoff window, `CommitConvergenceError`, disposition classes (permanent / terminal / give-up / backoff) | `scheduler/backpressure.ts:22-57`, `scheduler/events.ts:1096-1210`, `events.ts:1335-1387` | events §5 partially | CHANGED |
| 18 | CFC-rejected-write loud drop | `scheduler/events.ts:63-75` | serving-loop §3c (named explicitly) | COVERED |

### 1c. Events and handlers

| # | behavior | today (anchor) | v2 doc § | status |
| --- | --- | --- | --- | --- |
| 19 | Stream send → `queueEvent`; lifts cannot emit | `cell.ts:1300-1339`, guard `cell.ts:1307-1312` | events §2 (one path, two producers) | COVERED |
| 20 | Durable event ids minted per origin tx; caller ids scoped to the stream | `scheduler/event-identity.ts:26-84` | events §1 | COVERED |
| 21 | Per-(stream,handler) FIFO with W4 backlog cap 256, last-wins collapse, chained onCommit | `scheduler/events.ts:272-321`, `scheduler/constants.ts:39` | README §3.8 (backpressure hook only) | GAP |
| 22 | Event for a not-running piece: FIFO slot reserved, piece auto-started | `scheduler/events.ts:331-395`, `ensure-piece-running.ts:97-175` | serving-loop §1, §3 (demand-driven pull; the event is the demand) | RULED |
| 23 | Preflight: `populateDependencies`, recompute dirty inputs on demand before dispatch, load-park (CT-1795) | `scheduler/events.ts:503-708` | serving-loop §3, events §2 (cited as the freshness rule) | COVERED |
| 24 | `presyncInputs` await before dispatch | `scheduler/types.ts:60-68`, `scheduler/events.ts:907-917` | none (moot server-side) | CHANGED |
| 25 | Handler dispatch: immediate tx, `dispatchedEventId/Time`, commit not awaited | `scheduler/events.ts:929-949`, `1071-1086` | events §2; serving-loop §3d | CHANGED |
| 26 | Exactly-once handling: create-only receipt cell keyed by durable event id, `receipt-exists` / `origin-committed` preconditions (`commitPreconditions` flag), receipt-race loser drops | `runner.ts:4759-4817`, cause `runner.ts:5168-5171`, race `scheduler/events.ts:1173-1189` | events §4 (eventWatermark) | CHANGED |
| 27 | Speculation lineage: events/pieces launched by an uncommitted tx are dropped/stopped on origin failure; cross-space descendants park until origin commit | `scheduler/lineage.ts:18-126`, `scheduler/events.ts:717-737` | speculation §1-2 (client), serving-loop §3d (server) | CHANGED |
| 28 | Event wall-clock instant frozen at fire, cascade shares it, 1s-floored for patterns | `scheduler/facade.ts:1347-1350`, `scheduler/types.ts:186-197` | events §3 (capture rule names time-of-fire) | COVERED |
| 29 | Client handler-write commit path (the whole of §1c today commits from the client) | `scheduler/events.ts:1086` onward | events §7 (deleted under flag) | CHANGED |

### 1d. Piece lifecycle

| # | behavior | today (anchor) | v2 doc § | status |
| --- | --- | --- | --- | --- |
| 30 | `setup` / `start` / `run` / `runSynced`: argument staging, setup state, node instantiation | `runner.ts:1077`, `1941`, `2950`, `3052`, `startCore` `runner.ts:2037-2530` | serving-loop §3 (hosted runtime) | COVERED |
| 31 | Who starts pieces: shell navigation, `ensurePieceRunning` on event, CLI, roots at bootstrap | `ensure-piece-running.ts:97`, `runner.ts:2343-2530` | serving-loop §1 (no piece-start policy; demand-driven pull) | RULED |
| 32 | `stop` / `stopAll`: cancel groups, start-generation tombstones, lifecycle epochs | `runner.ts:3807-3852`, `3926-3956`, `2056-2077` | serving-loop §1 (park = dispose) | COVERED |
| 33 | Child pieces from list coordinators (map/filter/flatMap): per-element `runner.run`, identity reuse, stop-on-removal, `resumeMode: "always-run"` | `builtins/map.ts:344-412`, registration `scheduler/facade.ts:316-322` | builtins §1 (listed as pure) | CHANGED |
| 34 | Resume compensation for list builtins (`resume-recover`, `resume-republish`) | `builtins/resume-recover.ts:29-46`, used `builtins/filter.ts:165`, `flatmap.ts:105` | builtins §5 (do not port) | COVERED |
| 35 | Resumed-start machinery: per-doc rehydration snapshots, sync-holds, rehydration barrier | `runner.ts:3216-3395`, `scheduler/facade.ts:680-803`, barrier `scheduler/work-oracle.ts:79-86` | serving-loop §3b, §6 | CHANGED |
| 36 | Runtime teardown ordering: settle pointer commits, updater dispose, scheduler dispose | `runtime.ts:1343-1424`, `runner.ts:3900-3924` | README §4 (teardown O(1) budget) | COVERED |

### 1e. Results that are patterns (charm creation from computation)

| # | behavior | today (anchor) | v2 doc § | status |
| --- | --- | --- | --- | --- |
| 37 | Lift/computed returning reactives: `patternFromFrame`, result-pattern cache keyed by result doc, changed pattern re-`run` into the same cell, unchanged is a no-op, stop on commit failure | `runner.ts:5027-5140` (`5061`, `5094-5120`) | none by name | GAP |
| 38 | Handler returning reactives: result pattern run under the handler tx with receipt ownership; navigateTo-bearing results deferred to post-commit start | `runner.ts:4750-4923` (`4819-4847`), one-shot pull `runner.ts:4992-5025` | events §2 (consequences), builtins §3/§4 | GAP |
| 39 | `compileAndRun`: async compile off the action, result piece via `runSynced`, `pieceCreatedCallback` | `builtins/compile-and-run.ts:31-266` (`211-261`) | builtins §3 | CHANGED |

### 1f. Pattern-source updates

| # | behavior | today (anchor) | v2 doc § | status |
| --- | --- | --- | --- | --- |
| 40 | `systemPatternAutoUpdate`: post-instantiation background source check; pre-bootstrap default-root reconcile; schema-compat gate; pointer write | `pattern-updater.ts:70-531` (`80-122`, `442-465`, `476-511`), hook `runner.ts:2133-2146`; flag `docs/development/EXPERIMENTAL_OPTIONS.md` §systemPatternAutoUpdate | none | GAP |
| 41 | `patternIdentity` watcher: live hot-swap of running pieces on pointer change (setup, teardown, reinstantiate); unloadable-pointer roll-forward (CT-1923) | `runner.ts:2158-2341` (`2202`, `2168-2200`, `2259-2317`) | none | GAP |
| 42 | Piece source lifecycle records (revisions, transitions, provenance) | `runner.ts:623-748`, `6578-6903` | none (authored data; rides along) | COVERED |

### 1g. Built-ins

| # | behavior | today (anchor) | v2 doc § | status |
| --- | --- | --- | --- | --- |
| 43 | Registration: `registerBuiltins(runtime)`; effect flags per builtin; replayability registry | `builtins/index.ts:45-110`, `builder/builtin-replayability.ts` | builtins §Anchors | COVERED |
| 44 | `fetch*`: input-hash memo + cross-tab request mutex (5s staleness takeover) + hash-guarded writeback | `builtins/fetch-utils.ts:34-207`, `builtins/fetch.ts` | serving-loop §4-5, builtins §2 | CHANGED |
| 45 | `llm` / `generate*`: durable `requestHash` memo-hit rule; 1s-batched `partial` cell writes; sink-request release | `builtins/llm.ts:724`, `68-70`, `555` | serving-loop §4; protocol §6 (no partial commits) | CHANGED |
| 46 | `llmDialog`: multi-turn state machine | `builtins/llm-dialog.ts` | builtins §2 (new key per turn) | COVERED |
| 47 | `sqliteDatabase`/`sqliteQuery`: server RPC via signed first-party fetch; exec folded into caller commit; `reactOn` | `builtins/sqlite-builtins.ts`, `builtins/index.ts:70-77`, signing `toolshed-http-auth.ts` | builtins §2 (reader principal in key) | CHANGED |
| 48 | `streamData`: polling generator loop | `builtins/stream-data.ts:1-12` | README §3.5, builtins §5 (disabled) | COVERED |
| 49 | `navigateTo`: `runtime.navigateCallback` + post-commit outbox effect; session-scoped result cell | `builtins/navigate-to.ts:7-125` (`46`, `89-114`) | builtins §4, protocol §5 | CHANGED |
| 50 | `wish`: mention resolution, favorites, 50ms debounce — and per-runtime interval `#now` timers (ticking cells) | `builtins/wish.ts:109-123`, `945-1000`, `builtins/index.ts:106-109` | builtins §1 (listed pure) | GAP |
| 51 | `ifElse`/`when`/`unless`, list support modules, `inspectConfLabel`, `scopePolicy` | `builtins/if-else.ts` etc. | builtins §1 | COVERED |
| 52 | Post-commit effect outbox on the transaction: navigate, CFC sink-request release, sqlite writeback; `settled()` tracks flushes | `builtins/navigate-to.ts:89`, `cfc/sink-request.ts`, `scheduler/run.ts:557-572` | serving-loop §5 | COVERED |

### 1h. Cross-space, scopes, and authority

| # | behavior | today (anchor) | v2 doc § | status |
| --- | --- | --- | --- | --- |
| 53 | One-transaction-one-space writer rule; `enableMultiSpaceWrites(order)` child-first escape hatch | `storage/interface.ts:664`, `690`, `963`; `runner.ts:4698-4713` | protocol §2b | COVERED |
| 54 | `.inSpace()` provisioning: destinationSpace-threaded writes, foreign-first commit order, name cache | `storage/interface.ts:1269`, `runtime.ts:671` (name cache), rows 14/53 | protocol §2b | COVERED |
| 55 | Cross-space reads and foreign-commit wakes (per-doc client subscriptions today) | `runner.ts:1034-1036`, `storage/query.ts` | README §3.1, serving-loop §3b | CHANGED |
| 56 | Cell scopes `space`/`user`/`session`: scoped derived outputs, scoped result cells, scoped-slot writes exempt from surface checks | `scope.ts:11`, `runner.ts:5062-5092`, exemption `scheduler/run.ts:630-637` | scopes.md (RULED 2026-08-02) | CHANGED |
| 57 | Runtime bound to one user identity; outbound fetch signed as that user | `runtime.ts:669`, `666`, `toolshed-http-auth.ts` | README §3.8, protocol.md §1/§7 (identity RULED — R-Q6b; quota deferred) | CHANGED |
| 58 | ACL admission for authored writes | `acl-manager.ts:16` | protocol §2 (unchanged) | COVERED |

### 1i. Persisted scheduler state and observation sharing

| # | behavior | today (anchor) | v2 doc § | status |
| --- | --- | --- | --- | --- |
| 59 | Persistent scheduler state (experimental): payload-carrying observation rows, snapshots, replay table, read/write indexes, action state, context floors | tables `packages/memory/v2/engine.ts:153-325`; writer `scheduler/run.ts:667-772`; shape `scheduler/persistent-observation.ts:64-96` | serving-loop §3b | CHANGED |
| 60 | Rehydration eligibility by execution-context rank (space/user/session) against `completeActionScopeSummary` | `scheduler/facade.ts:184-191`, `210-278`, `927-953` | serving-loop §8 (tripwire identifiers) | GAP |
| 61 | `completeSchedulerScopeSummary` / `completeActionScopeSummary` emission (transformer marker; runner fills addresses) — two identifiers, one surface | `scheduler/types.ts:26-33`, `runner.ts:5682-5745`, ts-transformers (4 files) | README §5 (delete list), serving-loop §8 | CHANGED |
| 62 | Incremental observation adoption (adopt another client's committed run instead of re-running) | `scheduler/facade.ts:1019-1167`, `scheduler/invalidation.ts:39-49` | none | GAP |

### 1j. Protocol seams the specs assume

| # | behavior | today (anchor) | v2 doc § | status |
| --- | --- | --- | --- | --- |
| 63 | Commit classes / `derivedThrough` / `consequenceOf` metadata | not present today | protocol §1, §7 | COVERED |
| 64 | `execution_lease` table | **not present on main** (`packages/memory/v2/engine.ts` has no such table; repo-wide grep is empty) | serving-loop §Anchors, §2 | GAP |
| 65 | `externalSinkDisposition` / client egress suppression | not present on main; egress is CFC sink-request verification at release (`cfc/sink-request.ts:51`) | README §3.1, §3.4 | GAP |
| 66 | Settled-ness watermark; `waitForSettled` | not present today (tests poll `settled()`/text) | protocol §4, testing §3 | COVERED |
| 67 | Mergeable ops (push/addUnique/increment; op poisoning on whole-value set) | `storage/mergeable-ops.ts`, `cell.ts:1379-1392` | README §1 (authored machinery unchanged) | COVERED |
| 68 | Read-metadata classes feeding the reactivity log (scheduling-ignored, machinery, link-probe, mergeable-op reads) | `storage/reactivity-log.ts:53-95` | serving-loop §3b/§3c (log is the authority) | COVERED |
| 69 | Pattern compilation + caches (in-process compile, identity loads, artifact index) | `pattern-manager.ts:593`, `1111`, `2016` | builtins §3 (reuse toolshed path) | COVERED |

## 2. Notes on the non-trivial rows

**N2 (eager effects split).** Today one `isEffect` bit covers three
different things: external-effect built-ins (`llm`, `generateText`,
`generateObject`, `sqliteQuery` — `builtins/index.ts:60-97`),
`navigateTo` (`builtins/navigate-to.ts:122`), and render/UI sinks.
v2 splits them by §3.5 class: effectful built-ins become server-only
memoized nodes, navigateTo becomes the split contract, render sinks
stay client-side. The scheduler's effect/computation distinction
itself ports unchanged; only the *population* of the effect set
differs per posture. The eager-result one-shot pull after handler
commits (`runner.ts:4992-5025`, `EAGER_RESULT_BUILTIN_REFS`
`runner.ts:151-163`) exists to force network built-ins in fresh result
pieces; server-side, waves make it redundant — drop it there, keep it
in the OFF arm.

**N4 (materializers).** A materializer is a *computation* whose writes
land in caller-visible cells (write envelopes registered at
`runner.ts:5666-5681`); the scheduler seeds them at idle priority and
treats their eventual run as idle-blocking
(`scheduler/work-oracle.ts:116-127`, `164-187`). Under v2 they are
derivations — server-committed — but no v2 doc names them, and their
idle-priority seeding interacts with the wave's "run to idle" (a wave
is not done until idle materializers ran). Recommended default: they
are ordinary served computations; state this in serving-loop §3 when
Phase 1 meets them.

**N5 (action tx seals).** serving-loop §3d keeps `action(tx)` and the
per-action bookkeeping and changes only the destination. What
concretely re-routes: `startReactiveActionCommit`
(`scheduler/run.ts:94-106`) stops committing to the store and seals
into the wave accumulator; `watchReactiveActionCommit`'s conflict
paths (row 15) mostly dissolve because a sealed action cannot hit a
server CAS reject — the wave commit does, per doc (§3d drop rule).
The observation attach (`run.ts:667`) becomes the basis-row capture.

**N7 (self-echo).** Today's suppression is in-process:
`tx.sourceAction` marks the writer (`scheduler/events.ts:934-935`,
skip at `scheduler/invalidation.ts:165-167`). v2 adds the
*cross-process* form — skip by commit class + lease holder before
dirtiness marking — because the SpaceServer's own commits return on
the subscription. Both are needed server-side; today's mechanism
stays for intra-wave writes.

**N9 (time gates).** Debounce/throttle/auto-debounce ride along with
the hosted scheduler, but two interactions are unstated in v2: (a) a
gated wake (`gates.ts:341-356`) keeps the loop non-idle — parking
policy (serving-loop §1 IDLE_PARK_MS) must treat a pending gate wake
as "not idle" or accept losing trailing debounce flushes on park; (b)
auto-debounce arms off measured run times, which on the server shifts
*multi-user* latency, not one user's. Recommended default: keep gates
as-is, park only when no gate wake is armed; revisit budgets in
Phase 6.

**N10 (wake shaping).** The timing-side-channel shaping (per-pattern
token buckets over input events and cell flips,
`scheduler/wake-shaping.ts:1-40`) exists because sandboxed pattern
code must not observe sub-second real-world timing. The channel does
not vanish under v2 — pattern code observes authored-commit arrival
*server-side* instead. v2 docs are silent. Recommended default: keep
shaping in the SpaceServer for authored-commit wakes of pattern
readers (same code path — `shapableWakeGroupKey`,
`scheduler/invalidation.ts:56-77`, keyed off notification source);
drop the renderer-input special case client-side only if speculation
makes it moot. Needs a ruling before Phase 1 wires the wake path.

**N11 (quiescence).** `idle()` is the wave boundary (serving-loop §3
cites `scheduler.idle()`); `idleWithPendingCommits`
(`facade.ts:1208-1210`) and `runtime.settled()` (`runtime.ts:1197`)
exist to await in-flight *client* commits and async built-in work —
server-side, the wave commit is synchronous with the loop and the
outbox is tracked by counters, so these surfaces stay client/test
facilities. testing §3 replaces their use in integration tests with
the watermark.

**N15/N17 (retry machinery, what survives).** Survives server-side:
`RetryImmediately` (row 14 — re-run within the wave), the bounded
non-conflict retry (row 16), the disposition *classification*
(`isPermanentRejection`/`isTerminalRejection`,
`storage/rejection.ts`). Dissolves server-side: the off-budget
conflict re-queue (`run.ts:165-213`) and the event-commit backoff
window (`events.ts:1372-1386`) — with one deriver there is no
concurrent deriver to conflict with; the mid-wave authored race is
handled by the §3d per-doc CAS drop (`wave.supersededWrites`), and a
dropped write recomputes next wave. Survives client-side: the whole
backpressure stack, now applied to *authored* commits only (UI
bindings, event appends). `CommitConvergenceError` remains the
client's terminal surface. events §5 covers duplicate-submit; it does
not say which retry layers the client keeps — treat this note as the
answer (append retries yes, handler-write retries gone with row 29).

**N21 (event backlog cap).** The W4 cap (256 per stream+handler,
last-wins collapse, `events.ts:272-321`) is today's only
event-flood shaping. README §3.8 promises rate-shaping "at the
binding layer" — a different place. Both can hold, but the server
FIFO needs *some* bound because events now arrive from N clients into
one queue; recommended default: keep W4 in the SpaceServer unchanged,
add binding-layer shaping in Phase 6 as specced.

**N22 (auto-start on event) — RULED 2026-08-02, with N31.** There is
NO piece-start policy in v2: the space is one lazy reactive graph
(serving-loop §1). Today's auto-start (`ensurePieceRunning` holding
the FIFO slot, `events.ts:331-395`) maps to loading graph structure
sufficient to run the event's handler — the event IS the demand for
its handler; events run handlers eagerly, after preflight makes any
dirty state inputs current (D-v2-2, events.md §2). The derivation
path needs no analogue: a commit dirtying docs read by unmaterialized
nodes leaves them dirty-unmaterialized until a value-granular client
pull (a subscription) demands them and their upstream — `idle()`
already excludes them. Nothing starts a piece because its *inputs* changed,
and nothing "starts pieces" on activation at all.

**N24 (presync).** `presyncInputs` exists so a handler's synchronous
replica reads don't race doc-carrying storage responses. On the
SpaceServer the store is local (engine-v3 in-process), so presync
degenerates to a no-op — keep the hook, expect it to cost nothing.

**N25/N26 (dispatch + exactly-once).** Today's exactly-once story is
commit-time: handler ids derive from the durable event id
(`cause.$event = tx.dispatchedEventId`, `runner.ts:5168-5171`), the
handling's receipt cell is create-only-marked, and a redelivery loses
the receipt race server-side (`receipt-exists`,
`events.ts:1173-1189`) — all gated by the `commitPreconditions`
experimental flag. v2 replaces the *mechanism* with per-stream
`eventWatermark` (events §4): consequence commit and watermark
advance are atomic, replay skips at-or-below. What must not be lost
in the swap: (a) the *id derivation* (same event ⇒ same minted cell
ids) is what makes replays CAS no-ops for result cells — keep it; (b)
the verb contract reads a handling's result back by receipt address
(`tx.handlingReceiptLink`, `runner.ts:4767-4780`,
`plainResultReceipts`) — events.md is silent on result readback for
CLI/agent ingress; carry receipts as a value surface or re-spec the
verb contract. Flag as a Phase 3 decision.

**N27 (lineage).** Client-side under the flag, lineage's job — drop
descendants of a failed speculative commit — is absorbed by the
overlay (speculation §4: retire/rebase by eventId); the class deletes
there. Server-side, a handler's consequences run inside the same
wave, so "origin still pending" cannot happen for same-space sends;
for *cross-space* sends the outbox (protocol §2b) replaces the parked
cross-space event (`events.ts:717-737` becomes: append via outbox
after wave commit). The piece-stop compensation
(`runner.ts:4906-4919`) maps to per-action failure isolation in §3d.

**N31 (piece-start policy) — RULED 2026-08-02: none exists.** See
N22. The space root bootstrap (`startEnsuredDefaultPattern`,
default-root reconcile `pattern-updater.ts:111`) stays a client-era
framing: the SpaceServer never guarantees "root pieces run" — it
resolves demanded values and queued events, and handler registration
rides the structure load for exactly those, not a start step
(serving-loop §1). A root piece's handlers become reachable when a
client subscribes to its values or an event targets its streams;
until then its derivations stay dirty-unmaterialized by design.

**N33 (list coordinators are not "pure").** builtins §1 classifies
map/filter/flatMap as pure structural with "port cost: none". The
functions are deterministic, but the coordinators *start child
pattern runs* (`map.ts:355-395`), own their lifecycle
(stop-on-removal, `map.ts:392`), and register `always-run` on resume
because a clean skip would strand children (`map.ts:412`,
`facade.ts:316-322`). Port cost is real: server-side a coordinator
materializes under demand like any node (the N22/N31 ruling — no
activation start step), and the client's speculative run of a
coordinator keeps child starts overlay-local (see N37 — allowed
since the 2026-08-02 reversal). Amend builtins §1 when Phase 1 lands
them.

**N35 (resume machinery).** The whole client-resume complex — per-doc
snapshot buckets (`runner.ts:3296`), sync-holds
(`INITIAL_RUN_SYNC_HOLD_TIMEOUT_MS`, `scheduler/constants.ts:67`),
the rehydration barrier, resume-recover/republish (row 34) — exists
because a *remote* replica reloads against a store it has not
finished syncing. The SpaceServer's store is local and its recovery
is recompute-from-current-state (serving-loop §6), so on the server
this machinery is expected to reduce to: read watermark, subscribe,
recompute. It stays for the OFF arm and for client boot; do not port
it into the serving loop. If the loop seems to need a sync-hold, the
store locality assumption broke — stop and check.

**N37/N38 (result-as-pattern).** The runner instantiates pieces from
*computation results*: any lift/handler returning reactives becomes a
`patternFromFrame` pattern run into a deterministic result cell. For
lifts, updates re-instantiate in place when the serialized pattern
changes (`resultPatternCache` compare, `runner.ts:5094-5120`) —
unchanged results are no-ops, and a failed commit stops the child.
For handlers, the child run is owned by the handler tx (receipt
ownership, N26) and navigateTo-bearing results defer starting until
the tx commits (`runner.ts:4826-4847`) so the target is durable.
v2 placement: these run wherever the graph runs — server
authoritatively (the child joins the space's graph, as builtins §3
says for compileAndRun), client speculatively. Three consequences,
one now ruled: (a) speculative child *starts* on the client are
ALLOWED and overlay-scoped (owner, 2026-08-02, reversing the earlier
no-children rule) — registrations are not writes
(`runner.ts:4906-4908`); ids derive from cause so the speculative
child converges with the authoritative one by identity, and
speculation §2 now carries the lifecycle + retirement line; (b) the
lift-result re-instantiate happens inside a served wave — its writes
are wave writes, fine, but the JSON-stringify compare is the *memo*;
name it so nobody adds a second one; (c) the navigateTo deferral
becomes moot under §3.7
(intent lands in the wave's derived commit; the client enacts) —
delete the deferral in the ON arm rather than porting it.

**N39 (compileAndRun).** Matches builtins §3 (compile off the loop —
today via floating promise `compile-and-run.ts:211-247`; v2 moves the
async to the outbox). Two client hooks need placement:
`pieceCreatedCallback` (`compile-and-run.ts:261`, `runtime.ts:630`)
and the in-memory-only request dedupe (`previousCallHash`,
`compile-and-run.ts:153-158` — unlike llm there is no durable
requestHash today, so restart re-compiles; harmless but
counter-visible). Recommended: derive "piece created" from data (the
result cell), drop the callback server-side; adopt the §4 memo shape
for the compile request.

**N40/N41 (pattern updates — who triggers under v2).** Today the
*client* does both halves when `systemPatternAutoUpdate` is on (shell
ON, server processes OFF — EXPERIMENTAL_OPTIONS.md): the
fire-and-forget source check after an instantiation commit
(`runner.ts:2138-2145`) and the live hot-swap via the
`patternIdentity` meta sink (`runner.ts:2202`), including teardown +
reinstantiation (`2168-2200`) and the unloadable-pointer roll-forward
(`2259-2317`). Under v2 pieces run only in the SpaceServer, so the
watcher and the swap MUST run there — a pointer write is an ordinary
authored input that dirties the piece; the swap is the server
reacting. The *check* (network fetch + compile + verify + pointer
write) can live either server-side (SpaceServer instantiation hook,
matching today's placement) or stay a deploy/client action that just
writes the pointer. Recommended default: move both to the
SpaceServer, flip the flag's posture (on server-side under v2 ON),
keep the pointer write authored-class under the updater's principal.
No v2 doc mentions any of this; it needs a home (serving-loop §3 or a
new §) before Phase 1 serves a piece whose source updates mid-run —
`pattern-update-testing.md` scenarios are the acceptance surface.

**N44 (fetch mutex deletes).** The cross-tab mutex
(`tryClaimMutex`, `MUTEX_STALE_AFTER = 5s`,
`fetch-utils.ts:34-178`) exists only because N clients race one
effect. Single-deriver makes it dead: serving-loop §4's per-key
in-flight dedupe is the replacement. Also note today's fetch stores
its hash in a separate internal cell ({requestId, lastActivity,
inputHash}, `fetch-utils.ts:36-47`) — v2 §4 wants `requestHash` on
the result doc; migrate shape, keep `computeInputHashFromValue`'s
normalization (`fetch-utils.ts:72-99`) as the §4 canonicalization
seed. The deadline/redirect rules
(`docs/development/fetch-request-deadlines.md`) port unchanged
(builtins §2 cites them).

**N45 (llm partials).** The memo-hit rule v2 §4 specifies already
exists durably for llm (`hash === requestHashWithLog.get()`,
`llm.ts:724`) — Phase 1 generalizes it, not invents it. The 1s
partial batching (`llm.ts:68-70`) writes `partial` through cell
commits today; under protocol §6 partials must leave the commit
stream entirely (ephemeral channel or nothing). Deleting the partial
cell is a pattern-visible change (patterns read `partial` —
`builtins/index.ts:84,94`); the v2 baseline "settled-result-only" 
must say what `partial` reads as (recommended: stays `undefined`
under the flag).

**N47 (sqlite).** Today's row-level clearance happens where the read
is served (toolshed RPC under the caller's signed identity). v2 keeps
that and adds the reader principal to the memo key (builtins §2 —
per-reader materialization, RULED 2026-08-02) — which today's
single-user-runtime hash does not contain (`fetch-utils.ts:72` hashes
inputs only). The SpaceServer signs the RPC with *whose* identity
was row 57's identity question, now RESOLVED (N57 — R-Q6b:
per-action-context identity, never SpaceServer-ambient); the ruled
memo key already carries the reader principal, so two readers never
share a result.

**N50 (wish `#now` timers).** `wish` hosts per-(runtime, space,
interval) wall-clock tick timers that advance a ticking cell
(`wish.ts:945-1000`; bounds `wish.ts:109-123`). Whoever runs the wish
node owns a standing timer: server-side that means (a) a space with
an interval `#now` never quiesces, defeating IDLE_PARK_MS parking,
and (b) every tick is a derived commit — 1/s/interval against the
≤2× amplification budget's spirit (the budget is per authored input;
ticks have none). No v2 doc mentions time-driven computation.
Recommended default: server ticks (it must — downstream derivations
are committed state), parking policy exempts tick-only wakefulness by
lengthening the interval floor when no session is live, and testing
§4's amplification gate excludes tick commits. Needs an owner ruling
before builtins §1 ships `wish` as "port cost: none".

**N56 (cell scopes — the largest unplaced semantic).** The data
model has three cell scopes (`scope.ts:11`); derivations *narrow
their output scope from what they read* (`runner.ts:5062-5092`), the
runtime writes scoped slots outside declared surfaces
(`scheduler/run.ts:630-643`), navigateTo's result is session-scoped
(`navigate-to.ts:46`), and per-user/per-session UI state is a
documented pattern feature. "One committing runtime per space"
answers space-scoped derivations only. RULED 2026-08-02 (batch 3):
the SpaceServer derives EVERY instance of every scoped node — scope
keys instances, never authority; scope is discovered by running,
narrowing is written as redirects, and a narrowing discovery writes
the redirect plus the discovering run's OWN instance, with sibling
instances materializing on their own demand (scopes.md §2, as
corrected 2026-08-02). The normative
semantics now live in [scopes.md](scopes.md), with the
key-construction inventory in
[key-vocabulary.md](key-vocabulary.md). The alternatives this
row weighed (session-scoped derivations as client-speculation-only,
scoped state reclassified authored-adjacent) are rejected — scoped
derived state stays derived and server-committed, keeping today's
reload persistence. The persisted-state context ladder (row 60)
stays tripwired. The Phase 0 review continues (README §6 Q7, was
ledger L10). The 2026-08-02 scout pass verified scopes.md's anchors
and recorded in scopes.md §7 the five assumptions of main's scope
machinery that a SpaceServer breaks (M1–M5: per-identity scope
discovery; scope-NAME in-memory keying; no all-principals write
path; scope-NAME wake keys; no session-data GC); scopes.md §8 lists
what the review still owes (after the batch-4 closures: basis-index
DDL authoring + session-data GC design); row 57's identity
remainder is RESOLVED (N57, R-Q6b).

**N57 (identity/authority) — RESOLVED 2026-08-02 (R-Q6b).** Today
one runtime = one `userIdentityDID` (`runtime.ts:669`) and all
first-party HTTP is signed as that user (`toolshed-http-auth.ts`).
The v2 statement now lives in protocol.md §1/§7 and README §3.8:
the SpaceServer's envelope identity is its own service identity —
the lease holder; derived commits are a different trust class,
produced and admitted inside one trust environment — and per-run
identity is per-action-context WITHIN the commit (acting identity
per action RUN, explicit `scope_key` per scoped write), never a
SpaceServer-ambient user: the mapping's recommendation, now ruled.
The owner's 2026-08-03 modeling ruling generalizes this into the
transaction identity model (protocol.md §1): envelope identity for
single-session authored transactions, per-action-run annotations
inside the server-driven wave commit — closing ledger LD3 (the
shared `scope_key` vocabulary, key-vocabulary.md §3) and LD5 (the
lease-holder read row, protocol.md §2).
scopes.md §7 M3 resolves the same way — `resolveScopeKey`'s
session-fed admission path (`applyCommit`,
`packages/memory/v2/server.ts:2060-2063` → `engine.ts:2031-2032`)
narrows to
authored commits only; derived admission stays the lease check.
Effects still run under the capability handle's grant (README
§3.8); only quota attribution stays open (README §6).

**N59/N60/N61 (persisted observations vs the basis index).** Today's
experimental `persistentSchedulerState` writes payload-carrying
observation rows (full read/write address lists,
`persistent-observation.ts:64-96`) plus snapshot and replay tables
(`engine.ts:183-238`) — by serving-loop §3b's own test ("payloads or
per-run history ⇒ evidence"), today's shape is on the *forbidden*
side of the line. An earlier version of this note called
`scheduler_read_index` / `scheduler_action_state` "the kept basis
index"; that is WRONG and serving-loop §3b governs: both tables are
DROPPED and REPLACED by the new `scheduler_basis` schema, not
reshaped into it (they FK into the dropped `scheduler_observation`
and key by `process_generation`, which is per-process history where
v2 overwrites in place). What v2 keeps from the pre-arc feature is
the DECISION it made — warm start from recorded reads — not any of
its tables. Defer to serving-loop §3b for the drop list (SEVEN
tables), the new DDL, and the no-backfill rule. The context-rank
machinery (row 60,
`facade.ts:184-278`) and `completeSchedulerScopeSummary` /
`completeActionScopeSummary` emission
(row 61) exist *only* to decide cross-context sharing of persisted
state — with one deriver per space there is nothing to share, so
both delete with D-2026-08-02, including the four ts-transformers
call sites on main (`transformers.ts`, `schema-injection.ts`,
`lift-applied-strategy.ts`, `capability-analysis.ts`). Note the
tripwire list (serving-loop §8) currently *forbids* identifiers that
exist on main (`scopeSummary`, `contextKey`, replay table) — the
Phase 0 main-surface audit (plan §Phase 0) should record this
mapping's inventory as that audit.

**N62 (observation adoption).** Adoption existed so N client runtimes
didn't all re-run what one already ran — the multi-client symptom v2
removes at the root. Under the flag clients no longer run committed
derivations at all (reload is read-and-render, §3b), so adoption has
nothing to adopt; server-side there is no second runtime to adopt
from. DELETED in Phase 1 stage C.2, ahead of the original
delete-under-ON/keep-OFF-arm disposition: the stage's D7 protocol
deletions (serving-loop §3b) removed the feature's entire substrate —
the persisted rows it listed, the hello negotiation that gated it, and
the commit carriage that fed it — so keeping the receive path would
have kept dead code no server could ever feed. The caveat that came
with the disposition still stands: the sync-path comment in
`scheduler/invalidation.ts` (pushes had to stay unshaped for adoption)
lost its reason, so the shaping decision is due a re-check (N10).

**N64 (execution_lease does not exist).** serving-loop §Anchors and
§2 describe `execution_lease` as "an existing table"; it is not in
engine-v3's schema (`packages/memory/v2/engine.ts` CREATE TABLE set,
lines 153-424) and a repo-wide grep finds no reference. It existed
on the archived v1 branches only. Phase 1 must *add* the table (one
row per space: space, holder, expiresAt — §2's shape), its guard
wiring, and the derived-class admission equality check. Fix the
anchor in serving-loop.md in the same PR.

**N65 (egress suppression is new construction).** README §3.4
requires "client suppresses egress" and "server performs egress" to
move on one flag, and §3.1 says `"server-executor"` *remains* the
one `externalSinkDisposition: "allow"` — but no
`externalSinkDisposition` exists on main (v1-branch concept). Today's
egress control is CFC sink-request verification at post-commit
release (`cfc/sink-request.ts`), with no per-runtime disposition
dial. Phase 1/2 therefore *builds* the client-side suppression
(effectful built-ins not registered / read-through under the flag,
speculation §2) rather than flipping an existing dial. Fix the README
§3.1 phrasing when the flag lands.

## 3. Sweep completeness

Directories walked for this mapping, so later readers know what "all"
meant: every file in `scheduler/` (32 files) and `builtins/` (28);
`runner.ts`, `runtime.ts`, `pattern-manager.ts`, `pattern-updater.ts`,
`pattern-source-scheme.ts`, `ensure-piece-running.ts`, `cell.ts`,
`scope.ts`, `acl-manager.ts`, `cancel.ts`, `queue.ts`,
`reactive-dependencies.ts`; `builder/` (module/built-in/reactive/
pattern/factory/types/builtin-replayability); storage seams touched
by execution (`reactivity-log.ts`, `extended-storage-transaction.ts`,
`interface.ts`, `rejection.ts`, `mergeable-ops.ts`, `query.ts`) and
`packages/memory/v2/engine.ts` for the persisted-state tables.
Value-plumbing modules (link resolution, traversal, schema walking,
data-updating, sigils, slugs) ride along with the hosted runtime and
carry no placement question; they are deliberately not rowed.
