---
status: historical
created: 2026-08-20
archived: 2026-08-20
reason: "Land-off reconciliation — ONE merge of origin/main (bbcc7a348, 241 commits) into the train tip 45cca4167 on claude/server-exec-v2-land-off; 67-file conflict ledger; the five tx-boundary interaction findings (lead: the all-no-op wave is SAFE-BY-CONSTRUCTION with a green pin, executor-no-op-wave.test.ts); full suites green both arms; the ON gates reproduce W4's classes on the merged tree (lunch 3/3 {1:16}, chat n=20 median 534 ms, note p50 884 ms below OFF); flag stays OFF everywhere."
---

# Land-off reconciliation — the stage-C train onto main (server-execution v2)

Reconciler: the land-off integration agent, 2026-08-20. Worktree
`/Users/berni/labs-worktrees/land-off`, branch
`claude/server-exec-v2-land-off` (from the train tip
`origin/claude/server-exec-v2-w3-alpha` @ `45cca4167`). Strategy per the
owner's approval: ONE integration branch, **merge `origin/main` INTO the
train** (never rebase — the arc's recorded SHAs stay valid), a
first-class interaction review of main's tx-boundary work against the
train's scheduler metadata, full verification, ONE integration PR. The
flag (`EXPERIMENTAL_SERVER_EXECUTION`) stays OFF everywhere:
`SERVER_EXECUTION_DEFAULT_ENABLED = false` on the merged tree — the
train lands dark.

Facts: merge-base `30fdbb92f` (#5786); main moved 241 commits
(`bbcc7a348` at merge time), 68 touching `packages/memory` +
`packages/runner`. Merge commit **`820da28a2`**; reconciliation
follow-ups `9199ed344` (import dedup / identity threading / lint),
`868ec5311` (goldens regen), `0e8064f3c` (wish failure-UI), `cc74fa37f`
(verdict-catchup pins), `4df39643f` (the all-no-op wave pin).

## 1. The merge — conflict ledger

67 conflicted files: 61 content conflicts, 6 delete/modify. Resolution
rule: BOTH intents preserved; where a side's subsystem was deliberately
deleted by the train (the persistent-scheduler-observation surface,
stage C.2), the deletion stands and main's mechanical edits to it are
dropped. `deno.lock`: main's, per the vendor-tooling ownership rule.

### 1a. The delete/modify family (train deleted, main modified — all resolved DELETE)

| file | main's change | why deletion stands |
|---|---|---|
| `packages/runner/src/scheduler/persistent-observation.ts` | import conformance #5859 | C.2: observation tables → basis index |
| `packages/runner/test/scheduler-observations.test.ts` | #5993 coverage, #5954 mech., #5860 | same |
| `packages/runner/test/scheduler-observation-capability-skew.test.ts` | codec renames #5904/#5920 | same |
| `packages/runner/test/reload-rehydration-safety.test.ts` | import conformance | same |
| `packages/state-inspector/test/scheduler.test.ts` | import conformance | same (C.2's state-inspector slice) |
| `packages/memory/test/v2-scheduler-state.test.ts` | **#5800** staleness-scan test delta | the delta exercised `upsertSchedulerObservation` (0 refs on the train); #5800's real coverage lives in `v2-sparse-pending-dependencies.test.ts` (+269, merged clean) and the differential suite — KEPT |

### 1b. The hard content conflicts (the rest were import-block unions; `deno check` 41/41 groups verifies the whole set)

- **`packages/memory/v2/engine.ts`** (6 hunks): main's content-addressed
  no-op elision (#6020 — the `cid:`-scoped apply-time elision, the
  commit-time closure validation, `elidedOpIndexes` on `AppliedCommit`,
  the replay-path elision re-derivation) composed with the train's
  replay marker (`replayed: true` + the class/holder replay-mismatch
  guard), event-append stamping, and effects-doc transform. The
  observation-only/batch commit early-returns and the observation
  validator block (main-side) dropped with the deleted subsystem. Order
  in the apply loop: elision skip first, then the train's stamping
  (disjoint op families — elision hits `cid:` sets, stamping hits
  stream appends and the effects doc).
- **`packages/memory/v2/server.ts`** (8 hunks): the refresh loop keeps
  the train's push-priority phases AND gains main's evaluation-failure
  catch (`markSessionForFullResync`, skip-frame; the
  `adoptionObservations` option dropped — deleted subsystem). The
  session-transact accept path: elided ops excluded from BOTH the dirty
  keys and the admitted-commit feed's `writes` (activation follows
  novelty), `markSpaceDirty` size-guarded with main's all-elided
  catch-up-marker branch, the train's `#notifyCommitAdmitted` +
  event-append declarations kept and firing even for all-elided commits
  (the commit was RECORDED; the feed carries admitted commits, not
  novelty). The direct-write path: main's revision-count guard on the
  flush + the train's notify. The resume-catch-up comment fork resolved
  to the TRAIN's text (keyed retraction — stage A's sticky wire
  vocabulary; main's "INCOMPLETE" note described main's own
  implementation, which the train's machinery replaced). The
  observation wire-message branch + snapshot-query parser dropped.
- **`packages/runner/src/traverse.ts`** (4 hunks): main's
  delivered-whole meta-linked docs (#5989 — track-before-read for
  absent-target arrival reactivity, no schema traversal of meta docs)
  and the schema-doc closure machinery (content-addressed Phases 1–2)
  threaded through the train's instance-keyed `getTrackerKey(address,
  identity)`; the train's `traverseMetaLinkedDoc`/`MetaLinkedDoc`
  (already dead under its own REJECTING_SELECTOR) deleted per main.
  Main's two new 1-arg tracker-key call sites got the identity
  (`loadMetaLinkedDocFromLink` → its `identity` param;
  `loadSchemaDocClosure` → `context.scopeKeyIdentity`; schema docs are
  space-scoped by rule, so the resolved key is the space partition
  under any identity).
- **`packages/runner/src/storage/v2.ts`** (6 hunks): main's selector
  externalization (`externalizeSyncSelector`) + arrived-schema-document
  validation + the rejected-pending-layers guard composed with the
  train's per-(doc, instance) replay keys, keyed frames, and
  identity-threaded `finalizeRejection` (rebuilt whole:
  the train's body inside main's `#rejectedPendingLayers` try/finally).
  Main's scheduler-snapshot provider methods dropped;
  `pullToServerHead` kept.
- **`packages/runner/src/builtins/wish.ts`** (8 hunks): the train's
  per-demander sidecar slots (fan-out stage B; `sidecarIsServed`
  branches; serving-space-aware fetches) keep main's #5818 idle-hold —
  `trackSidecarLaunch` wired on all three launch paths — and main's
  create-surface failure UI restored inside the slot structure
  (`0e8064f3c`; red-first on main's own pin AND the train's
  render-create-input test, which failed without it).
- **`packages/runner/src/runtime.ts`** (8 hunks): main's
  `contentAddressedSchemas` flag (+ the sync-schema-table interlock)
  kept; `persistentSchedulerState` deleted everywhere (env map,
  interface, init, resets); dispose = the train's
  `#disposeInner`/enabler-release structure with main's finally-based
  teardown (config resets and `runner.dispose()` reach the error path).
- **`packages/runner/src/storage/extended-storage-transaction.ts`**:
  `recordCfcDereferenceTrace` = the train's `#noteCfcActivity` + main's
  repeat-trace digest guard; `hasWrites` unified (own write-path bit OR
  the inner tx's flag — each side's consumer keeps its signal: the
  train's CFC-activity accounting and main's read-epoch fast path).
- **`.github/workflows/deno.yml`** (2 hunks): the train's two ON lanes
  + main's test-records-ship steps, both kept; YAML parse-verified; all
  22 jobs present including `build-toolshed-on` and both
  `*-server-execution-on` lanes.
- **`packages/memory/test/v2-verdict-catchup.test.ts`**: rebuilt from
  both sides — the train's publication-turn re-pin kept; main's THREE
  elision tests added (cid re-set no novelty / all-elided marker /
  direct re-write nothing — they pin exactly the merged server paths);
  main's connection-layer versions of the two requeue pins adopted
  (`cc74fa37f`; the evaluation boundary now logs-and-skips, so the
  train's evaluation-layer stubs asserted a throw the merged server no
  longer produces); base's "mid-batch failure" test dropped with its
  premise (it asserted `flushSessions` throws); main's
  adoption-injection test ("a throwing refresh evaluation skips that
  session's frame") DROPPED — its failure-injection surface
  (`attachAdoptionObservations`) is train-deleted — **FLAGGED**: the
  skip-frame catch survives and is pinned by the surviving
  "evaluation failure skips only that session's frame" test (injects
  via `syncSessionForConnection`, a live surface), but the
  marker-rollback-after-partial-consumption aspect of the dropped test
  has no equivalent pin.
- **`packages/memory/test/v2-query.test.ts`**: both sides' appended
  tests kept (the train's instance-key/loadedAddresses pins + main's
  ten schema-closure tests), file rebuilt from both sources after the
  positional splice broke a statement.
- **Flag surfaces** (`runtime-presets.ts`, shell `felt.config.ts` /
  `env.ts` + tests, `runtime-client/protocol/types.ts`,
  `EXPERIMENTAL_OPTIONS.md`): union of `serverExecution` (train) and
  `contentAddressedSchemas` (main); `persistentSchedulerState` rows
  and defines dropped. Two stale train comments claiming "ON since the
  plan's Phase 7 flip" corrected to the landed-dark truth in the two
  spots the merge touched (`shell/src/lib/env.ts`, its test); the same
  stale phrase survives verbatim in `runtime-presets.ts` (untouched by
  conflict) — **flagged, cosmetic**: the constant and the absolute pin
  state the truth.
- **Semantic choices flagged (conservative reading taken)**: (i) the
  admitted-commit feed fires for all-elided commits with an empty
  `writes` list (recorded-not-novel; over-notification is the safe
  direction — a spurious quiet pass vs a feed blind to a recorded
  commit); (ii) elided ops excluded from `committedWrites` (activation
  follows novelty — matches the memo's no-downstream-dirty half, which
  the no-op-wave pin asserts).

### 1c. Merge-produced test/tooling deltas

- Traverse replay goldens REGENERATED on the merged tree (the
  harness's deliberate-semantic-change rule). The regenerated goldens
  are **byte-identical to MAIN's** (0 differing invocations on both
  fixtures vs main; the 4/2396 + 175/20000 train-vs-merged diffs are
  exactly main's delivered-whole/`hash:"undefined"` semantics), and
  the readSet / schemaTracker sizes are IDENTICAL across train, main,
  and merged (11288/24766 notebook; 9957/28513 toolshed-reload).
- `executor-no-op-wave.test.ts` NEW (the §2.1 pin below); its file
  joins `realClockFiles` (the serving loop is wall-clock-paced).

## 2. The tx-boundary interaction review (the owner's question, first-class)

The owner, verbatim: *"main doesn't write scheduler meta data and we
do, so even a no-op is something to be recorded, right?"*

### 2.1 `61ab0e895` — identical content-addressed re-set applies as a no-op → **SAFE BY CONSTRUCTION, pin GREEN**

**Mechanism (determined first):** the memo bites at APPLY time,
per-operation, and is scoped to **`cid:` content-addressed SETS only**
(`engine.ts`: `if (!operation.id.startsWith("cid:")) … continue` before
the elision logic; `delete`/`patch` on `cid:` are protocol errors; the
elision drops the revision/head-advance/dirty-mark while **"the commit
still records and advances the space log"** — main's own comment). A
wave's derivation writes target `computed:`/`of:` docs — NEVER `cid:` —
and under the landed-dark defaults no link writer emits `cid:` refs at
all (`contentAddressedSchemas` off), so the overlap between main's memo
and the train's wave writes is EMPTY today, and even flag-on it touches
only redundant schema-doc reinstalls, whose commit still records.

**The per-run scheduler metadata is per-run-unique in the relevant
sense:** it rides the commit envelope and engine rows (per-action-run
annotations, `derivedThrough`, event stamps), not `cid:` operations —
the memo has no path to it. And the train's OWN no-op machinery is the
active one here: a run recomputing the stored-identical value seals an
all-no-op tx and "contributes nothing" (wave.ts); a wave with zero
contributions commits nothing (commitWave's zero-contribution return);
coverage then rides the input-driven advance-only wave and the S1
drain-settle quiescence advance.

**The all-no-op wave pin** (`packages/runner/test/executor-no-op-wave.test.ts`,
GREEN 3/3 at load < 5): an ON serving loop, an authored input whose
demanded derivation recomputes to the stored value (a saturating
`computed`) → the coverage still lands (`W ≥` the no-op input's
authored seq), `waitForSettled` RESOLVES past it, **no fresh derived
content commit** (≤ the advance's own bookkeeping row), **no value
re-push** (the client's sink sees exactly one distinct value), and **no
livelock** (the derived-commit count is flat across a settle window). A
CONTROL arm — the same trigger with a non-saturating twin — lands a
fresh derived write, proving the no-op reading is a no-op RUN, not a
never-ran.

One contract subtlety the pin encodes (found the hard way — the pin's
first draft was RED for asking an unsatisfiable question): **W
definitionally never covers the quiescence advance's own bookkeeping
seq** (anti-storm; the settle-advance suite's "−1 tolerance"), so
settle targets must be INPUT (authored/content) seqs — which is exactly
`waitForSettled`'s production use and W4's settle-series definition.

### 2.2 `a3fcd6047` — a transaction resolves a link once → **SAFE BY CONSTRUCTION**

The memo (`snapshotMemo`) is a private field of
`ExtendedStorageTransaction` — its lifetime IS the tx's, unreachable
from any other tx. It is dropped on EVERY write
(`invalidateReadResultCache` replaces the map), on
`resetNarrowestReadScope`, and WITHHELD under a read epoch, once CFC is
prepared, inside ambient-read-meta scopes, and under the UI blind-write
mode (all verified present in the merged file). The train's boundary
reshapes cannot leak it: a seal FINISHES its tx (no further derivation
reads flow through it); the wave folds sealed assemblies (data), not
live tx reads; a rejected/rebased speculation re-runs through
`finalizeRejection → dropPending →` a FRESH tx whose memo starts
empty. There is no cross-tx reuse channel. (The read-epoch guard also
means main's #5948 materialized-read instants disable the memo
outright.) Covered operationally by the whole runner battery + the ON
gates; no dedicated new pin — the ownership argument is structural.

### 2.3 `5c726d998` — report a settled transaction's commit as a result → **SAFE; the fix PROTECTS the train**

The fix's substance: a second `commit()` on a non-ready tx reports the
terminal `StorageTransactionCompleteError` as a RESULT without touching
the RUNNING commit's verdict — previously the doomed commit could steal
the verdict dispatch and get the winner's **post-commit outbox
discarded instead of flushed**. The train's effect outbox and verdict-
gated consequence path ride exactly that seam, so main's fix removes a
hazard for us rather than adding one. The settle instrument
(`waitForSettled`) reads the watermark DOC, not commit results —
unaffected. The (α) run-count evidence on the merged tree: consequence
multiplicity **{1:16} in all three lunch ON stores** (zero MULTI rows,
`inspect-store.py` per run), events 11/11–11/15 processed with
`orphanDeliveriesRefused` 0 and `lt1LateSealsRefused` 0, and the α
pins (F1/F2, events-down, wave suites) green in the battery.

### 2.4 Content-addressed schemas Phases 1–2 + delivered-whole meta docs → **NO SHAPE CHANGE; nothing left the closure**

- (d′) probe suites green on the merged tree: `executor-dprime-w0.test.ts`,
  `executor-fan-out.test.ts`, and the full executor family ran inside
  the runner battery (both halves green).
- Replay-golden closure shape: readSet and schemaTracker sizes
  IDENTICAL train/main/merged on both fixtures (§1c).
- Live demand sets vs W4's recorded blocks: **chat** demandedInstances
  859 vs 849 (+1.2%), demandedWriters **223 = 223**, demandedRows 1986
  vs 1988; **lunch** demandedInstances 701 vs 680 (+3%),
  demandedWriters **184 = 184**. The writer set — the derivation
  surface the loop runs — is exactly unchanged; the instance-count
  drift is run-length noise (the loaded-box lunch run doubled passes
  at the same rates). The task's "~830 keys" chat datum ≈ 849→859.
- Nothing the client renders left the closure: every gate rendered
  (chat text n=20 both browsers, lunch roster/tallies/swatches, note
  list) — no BLOCKER.

### 2.5 Proxy/writability + read-instant family → **CLEAN; one aligned semantic delta noted**

No `{ proxy: true }` remnants in the executor/speculation/scheduler
surfaces (swept); the whole battery + posture-probed binary gates cover
the migration (`0c9ea8a8a`'s notes: schema-declared handlers, asCell
for writes — the train's serving loop writes through cells/tx, never
query proxies). The named semantic consequence — captures under a
`true` `$ctx` schema stay `computed:`-eligible where `{proxy:true}`
used to disqualify them — is ALIGNED with the train's id-class rules
(`computed:` is excluded from piece demand by the ruled id-class
exclusion; more honest computed-minting means fewer futile demands).
The read-instant epoch (`129215d4c`/`9c0881506`) composes with the
tx memo (§2.2's withhold) and rode the battery; `8b6e770af` (decode
once) and `83d5a98c8` (schema-memo) are perf caches the gates exercise;
`6a12c7204`'s cold-load memoization ran under every suite.

## 3. Verification on the merged tree

Type check: `tasks/check.sh` GREEN, 41/41 groups. fmt + lint green on
all 58 hand-merged files. `check-docs` (559 blocks) + history index
(134 entries / 192 docs) green.

| suite | result |
|---|---|
| runner (package task, split halves, fake-clock preload) | **1 258 passed / 7 161 steps / 0 failed** (451+807) |
| memory | **552 / 271 steps / 0 failed** |
| toolshed | **142 / 428 steps / 0** |
| runtime-client | **64 / 221 / 0** |
| piece | **37 / 463 / 0** |
| spec-model | **23 / 0** |
| shell | **58 / 176 / 0** |
| skip-list validator | **17 / 0** |
| runner integration (lane scope `*.test.ts`, real toolshed) | OFF **14/14**; ON **14/14** (skip-filtered) |
| sx2 family (5 files, real binaries) | explicit-ON **5/5**; default-OFF **5/5** |
| traverse-replay vs regenerated goldens | **3 / 4 steps / 0** |

**Binaries** (both built from `cc74fa37f`; `dist/toolshed` via
`deno task --no-lock build-binaries toolshed`): OFF `9068495cf064ddeb…`
(define `null`, no `servingLoop` key), ON `81802d66713b38c1…` (define
`"true"`, `servingLoop` present, "serving loop ON" start line). Posture
probed per run (meta + stats pre/post); `No default model available`
per run; fresh store per run (fresh cwd); ports 8960/8961/8962.

**The ON gates** (per-run details under the session scratchpad
`landbench/runs/`):

- **Lunch 3/3 GREEN** — joins 263/255/269 ms, merges 552/108/248 ms,
  swatch walls 3/1/1 ms, consequence multiplicity **{1:16}** in all
  three stores (zero MULTI), `lease.lost` 0, events 11/15 (4 purged
  LT1 leftovers) / 11/11 / 11/12, orphans + late seals 0. (l1 ran at
  1-min load 181 — a concurrent labs perf agent plus the user's live
  loom services — and still passed every gate; its wall times are
  excluded from the timing table. l2/l3 ran at load ≈ 5.)
- **Chat ON n=20 smoke** — series COMPLETE, median 534 ms; server
  settle all-inputs p50 **20.0 ms** (n=68; value-only 24.7,
  structural-growth 13.6; p95 424 ms); events 28/28; `lease.lost` 0;
  no `walkRuns` key anywhere in stats (checked every ON run).
- **Note ON n=20 smoke** — series COMPLETE n=40 (2 steps × 20);
  createToView p50 **884 ms**, FLAT (first-10 median 826 → last-10
  1 176 — no monotone blowup); rc=1 on the **pre-existing**
  `splitDefinitions` browser-console gate (W4 §6.2's exact error, same
  attribution: `reference-block.ts:62` in the note pattern — not the
  merge's).

**W4-lite re-anchor** (one OFF→ON→OFF triplet per workload; PROVISIONAL-merged —
box shared with live loom services, 1-min loads 5–8 recorded per run;
adjacent pairs only):

| metric | W4 @ `44bb76b05` (train) | merged @ `cc74fa37f` |
|---|---|---|
| chat send→other-browser median (ms) | OFF 217–253 / ON **421–520** | OFF 273 / **ON 534** / OFF 399 |
| chat sender echo p50 (ms) | OFF 108–114 / ON 166–264 | OFF 127–175 / ON 312 |
| chat server settle all-inputs p50 (ms) | 18 / 15 | **20.0** |
| lunch totals (s) | ON 3.96–5.65 / OFF ~3.0–3.1 | ON 4.7 / 4.8 (quiet runs) / OFF 3.8–5.2 |
| lunch join / swatch (ms) | 253–254 / 1 | 255–269 / 1 (3 on the load-181 run) |
| lunch server settle all-inputs p50 (ms) | 17 / 20 / 17 | 258 (load 181) / **69 / 28** |
| note createToView p50 (ms) | ON **829–991** / OFF 1 100–1 193 | ON **884** / OFF 1 143 / 1 261 |
| lease.lost / {1:N} | 0 in 7/7; {1:16} | 0 in ALL ON runs; {1:16} ×3 |

Reading: both baselines moved a little (the box is busier than W4's
session), and every W4 CLASS reproduces on the merged tree — chat
arrival stays sub-second ON (the several-second sends stay GONE), the
sender echo stays the known 1.5–2.4× client-(e)-term gap, note stays
FLAT and below OFF at p50, lunch joins/swatches stay at W4's exact
numbers, settle p50 stays tens-of-ms on quiet runs. No W4 bar verdict
changes. The full W4 protocol was NOT re-run (per scope); label:
PROVISIONAL-merged.

**Registered flakes:** neither of the two effect-channel shapes fired.
The one out-of-family red seen: `executor-no-op-wave`'s own draft
asserting on raw `serverSeq` (a test-authorship error, §2.1, fixed) —
not a product flake.

## 4. What stays owed (unchanged by this merge)

The register (`docs/specs/server-side-execution/verification-coverage.md`
§3) remains the ledger: OW31's write-authority BUILD (post-merge,
pre-flip), OW40 (speculation §4 step-4 rebase), OW42 (the tracked-set
drain, trigger OW24), OW44 (flag 9's follow-up), the shape-(b)
deterministic cascade ids trigger (S2, acknowledged/deferred), and the
flip's own ordered gates (skip list EMPTY, deployed binaries ON,
OW31's ruled posture built, the benchmark against the owner's bar —
OW38 (ii)). This PR's CI run is the stack's FIRST-EVER CI execution
(stacked PRs got none; `deno.yml` triggers on main + PRs into main).

## 5. Process notes for the successor

- The box carried 1-min loads up to 181 mid-session (a concurrent labs
  perf agent in `labs/.claude/worktrees/topics-pattern-perf-*` + the
  user's live loom daemon + Spotlight over two 620 MB binaries).
  Functional gates held; every timing row here carries its recorded
  load, and the load-181 lunch run is excluded from timing claims.
- The runner package suite no longer fits one 600 s foreground call —
  split it (this run: 311 + 313 files, both green).
- `deno test` on `packages/runner/integration/` DIRECTLY also picks up
  `.test.tsx` files the CI task's `*.test.ts` glob never runs; 7 of
  them fail at import (`commonfabric` export shape) on main's side too
  — not a lane, not a regression.
