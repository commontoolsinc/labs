# Lunch-poll perf investigation — session handoff (2026-06-15)

Continuation of willkelly's #4141 ("Keyed collections POC + lunch poll perf
diagnostics"). This doc records where the investigation stands so a fresh session
can resume without re-deriving anything.

## Where this lives

- **Worktree:** `cf-feat-1/labs-perf`, branch `perf-investigation` (created off
  `origin/poc/keyed-collections` = wilk's #4141). Isolated from the lunch-poll
  feature checkout in `cf-feat-1/labs` (on `gideon/lunch-poll-freetext-join`,
  PR #4145).
- **Harness:** `packages/patterns/lunch-poll/diagnose.ts` (wilk's). Run headless:
  ```bash
  cd cf-feat-1/labs-perf
  deno run -A packages/patterns/lunch-poll/diagnose.ts \
    --program=<file>.tsx --cases=1x2,3x5,10x5 --rounds=3 --skip-refresh
  ```
  `--cases=n×u` = options × users; `m = users × rounds`. `--skip-refresh` omits
  the per-option homepage/image AI enrichment phase. Reports per-phase graph
  node/edge counts + `topReadSites`; emits `ConflictError` retries during the
  concurrent-vote-round phases. Full wilk findings: `keyed-collections/PERF.md`.

## The three cost centers (lunch poll's "minutes to load")

| # | Cost center | Scales with | Status |
| - | ----------- | ----------- | ------ |
| A | array-vote-aggregate reactive-graph growth (~1 node+edge per vote) | votes × options | **confirmed**, fixable |
| B | per-option AI enrichment on load (image gen + web search + generateText, behind a 30s mutex) | option count (cold) | confirmed; **separable**, not yet addressed |
| C | concurrent-write `ConflictError` retries (read-modify-write of the shared `votes` cell) | users voting at once | **confirmed**; keyed/indexed does NOT fix it |

NOTE: our merged #4144 moved *history* to SQLite but **votes are still an
array**, so A and C are fully live on current `main`.

## Results so far (3×5 case, `--skip-refresh`, this machine)

| variant | graph (host-adds) | retries | wall | final votes |
| ------- | ----------------- | ------: | ---: | ----------: |
| `main.tsx` (array) | 397n / 1004e | 36 | 57.5s | 15 ✓ |
| `main-indexed.tsx` (keyed cell, wilk's) | 68n / 139e | 36 | 14.2s | 15 ✓ |
| `main-sqlite.tsx` (`reactOn: db`, NEW) | **52n / 81e** | 7 | 12.4s | 1 ✗ |
| `main-sqlite-rev.tsx` (`reactOn: sqliteRev`, NEW) | 53n | 7 | 11.8s | 0 ✗ |

1×2 for reference: array 214n/463e/3-retries; indexed 54n/105e/3; sqlite 52n/81e/3.

### Solid conclusions

- **A confirmed + ranked.** Array graph grows with votes (397n at 3×5); indexed
  is ~flat (68n); **SQLite is flattest (52n, identical at 1×2 and 3×5)**. Both
  alternatives crush the array baseline on graph size and wall time.
- **C confirmed.** Array and keyed-indexed show **identical 36 retries** at 3×5
  (3 at 1×2) — both read-modify-write a shared `votes` cell. The keyed/indexed
  approach fixes graph scaling (A) but **not** write contention (C). Retries grow
  super-linearly with concurrency (2→5 users ⇒ 3→36 retries).

### The open confound — RESOLVED 2026-06-15 (writes DROPPED, not unsurfaced)

The SQLite variants showed only **7 retries** but also **failed to surface votes**
(final 0–1 vs 15 at 3×5). Confound: "per-row inserts dodge contention" vs "writes
don't land / don't surface." **Resolved by a cold-reader probe**
(`probe-sqlite-landing.ts` + `MultiRuntimeHarness.addColdSession`): after the
3×5 vote rounds, open the piece in a FRESH runtime that never subscribed — its
first `sqliteQuery` has an empty `requestHash`, so it reads **canonical server
SQLite truth**, bypassing every `reactOn`/dedup/cross-runtime hop.

**Verdict: WRITES DROPPED.** Cold auditor sees **1/15** in storage. Stderr
confirms the mechanism: **14 of 15 `castVote` transactions** (`main-sqlite.tsx:260:3`)
emit `Event handler transaction failed after exhausting all retries` — they blow
`editWithRetry`'s ~5–6 budget contending on the **shared handle `rev`** that
`db.exec` read-modify-writes ([cell.ts:1133-1142]). 15 attempted − 14 dropped =
1 landed, matching the cold count exactly. (76 raw retry WARNs + 14 hard
exhaustions.)

**This INVERTS the tentative read.** SQLite does NOT dodge contention — the
`rev`-as-mutex serializes ALL writes through one cell (same contention as a shared
array cell) but with a **hard retry ceiling that silently drops writes** instead
of converging. Array/indexed RMW a shared cell too, but their retries converge so
all 15 land (final 15 ✓, ~36 visible retries); SQLite drops 14 (final 1 ✗). So
SQLite-as-written is **strictly worse under concurrency**, not better.

The diagnose "7 retries" is therefore **not** low contention — it under-counts,
because its retry metric only registers retries on transactions that *eventually
commit*; the 14 that exhausted-and-dropped never appear. Do not use diagnose's
SQLite retry number as a contention measure.

Note the 1/15 is **lost writes, NOT the reactive-propagation gap** — if writes had
landed, the cold reader would have read 15. The propagation gap (below) is real
and separate, but it is not what causes 1/15 here.

Adding a bumped `sqliteRev` counter (`main-sqlite-rev.tsx`) did not fix surfacing
(still 0) — now expected: a second shared RMW cell (`sqliteRev`) ADDS a contention
point, so it can only worsen the drop rate, never raise *successful*-retry counts.

### Re-validated on rebased main — 2026-06-16 (3×5, `--skip-refresh`, this machine)

Re-ran all four variants (3 reps each) + the cold-reader probe (3 reps) + a 1×2
control on the rebased `main` (latest runtime + wilk's POC), via a multi-agent
workflow with adversarial verification. **The 2026-06-15 conclusion HOLDS in full,
and the mechanism is now `structural+measured` (code path AND numbers agree), not
model-only.**

| variant | maxNodes / maxEdges | retry WARNs | exhaustions | final votes |
| ------- | ------------------- | ----------: | ----------: | ----------: |
| `main.tsx` (array) | 431n / ~1190e | 72 | **0** | 15 ✓ (reps 1–2) |
| `main-indexed.tsx` | 68n / 140e | 72 | **0** | 15 ✓ (3/3) |
| `main-sqlite.tsx` | 54n / 84e | 82–83 | **14** | **1 ✗** (3/3) |
| `main-sqlite-rev.tsx` | 55n / 86e | 83 | **14** | **1 ✗** (3/3) |

- **Drop is real, not a propagation gap.** Cold auditor reads `voteCount=1`, all 5
  live sessions `=1` (3/3 reps). Cross-checked by an adversary with a *distinct-SQL*
  count query (`SELECT COUNT(*) … WHERE 1=1`) whose different `requestHash` is
  dedup-proof — still returned 1, so it round-tripped to the on-disk file. The db is
  **space-scoped** (`sqlite-builtins.ts`: `scope = outputBinding?.scope ?? "space"`;
  `main-sqlite.tsx` declares no scope), so the fresh-identity cold reader hits the
  same identity-independent file. Not a partition/dedup artifact.
- **Conservation closes exactly:** 1 survivor + 14 `exhausting all retries` = 15
  attempts. The 3×5 vote rotation is a Latin square → **15 distinct `(voter,option)`
  keys**, so `INSERT OR REPLACE` collapses nothing — denominator 15 is correct.
- **1×2 control LANDS all (2/2 `WRITES LANDED`)** → the drop is **concurrency-induced**,
  not constant.
- **Silent-drop path nailed structurally:** `send()` commits only the (uncontended)
  event *enqueue* and resolves; the actual `castVote` handler tx runs later
  *fire-and-forget* in the scheduler; on retry exhaustion the un-awaited commit takes
  the **log-only** branch (`events.ts:663`) and abandons the tx — so cases finish
  with `ok:true` and full JSON while 14 rows silently never land. Ceiling is
  `DEFAULT_RETRIES_FOR_EVENTS=5` (`scheduler/constants.ts:5`), **identical** for all
  three variants, so the divergence is contention crossing a fixed ceiling, not a
  budget difference. At 3×5 SQLite (wider commit window) crosses it while the cell
  variants stay under. **[Superseded by Phase 3 below:** the early guess that
  `indexed`'s `.key(optionId).key(me)` sub-paths reduce contention is **wrong** —
  `indexed` contends byte-identically to `array`; keying fixes cost-center A
  (graph), not C (contention).**]**

**Correction to the line-90 note above.** `main-sqlite-rev.tsx` does **not** remove
the `rev` mutex — `db.exec` *unconditionally* RMWs `handle.rev` (`cell.ts:1133-1142`),
and `main-sqlite-rev.tsx:272` adds a *second* `sqliteRev` RMW on top. It measures
**1/15, identical to plain sqlite** — but that is **floor saturation** (only one
writer can win the serialized race, so ≤1 can ever survive at 3×5), *not* evidence
that the extra counter "worsens" drops, nor (as the workflow first inferred) that a
"wider write window" is independently load-bearing. **What is established:** all
writes funnel through one shared `handle.rev` under a fixed 5-retry ceiling
(`i` + `iii`). **What is NOT yet separated:** the relative contribution of the
`rev` funnel vs. the SQLite commit's own conflict window — both variants sit at the
1-survivor floor, so 3×5 can't distinguish them. A cleaner separation needs a
lower-concurrency sweep (e.g. 3×2, 3×3) or a per-option-handle variant.

**Caveats / byproducts (do not affect the conclusion):**
- `main.tsx` rep 3 hit a **flaky `CloneForMutationError`** (`non-mutable-leaf`,
  `valueKind:null`) in the user-3 worker's pull-settle loop
  (`scheduler/pull-execution.ts`) — `results[0].ok=false` yet **process exit 0**
  (harness exit-code blindness: failure detection requires parsing JSON, not the exit
  code). Array baseline therefore rests on n=2 valid reps (both 15/15). Separate
  flaky-worker issue, not a votes signal.
- `retry WARN` counts roughly doubled vs the old base (array/indexed 36→72, sqlite
  7→83); ordering preserved and `exhaustion`/`finalVotes` stable. Reinforces: the
  diagnose retry number is not a usable contention measure.
- The silent-drop link is `structural+measured`-by-inference (conservation), **not**
  yet by a fired counter at `events.ts:663` mapped to specific missing rows — that
  instrumentation is the definitive close (see agenda).

### Phase 3 — cost-center C characterized (2026-06-16)

Concurrency sweep, options=3, rounds=3, `--skip-refresh`, each (variant,concurrency)
in its OWN invocation (clean per-case stderr), strictly serial. Attempted distinct
votes = 3 × users. Cell-variant drops were **cold-verified** (not trusted from the
reactive read, which Phase 3 proved unreliable — see below).

**C-curve (array ≡ indexed on every contention signal):**

| users | attempted | retryWarns | finalVotes | exhaustions | indexed n / array n |
| ----: | --------: | ---------: | ---------: | ----------: | ------------------: |
| 2 | 6 | 6 | 6/6 | 0 | 68 / n/a\* |
| 3 | 9 | 20 | 9/9 | 0 | 68 / 423 |
| 5 | 15 | 72 | 15/15 | 0 | 68 / 431 |
| 10 | 30 | 186 | **18/30** | **6** | 68 / 436 |

\* array 3×2 had NO valid rep — flaky `CloneForMutationError` in the join phase (see byproduct).

- **C is super-linear but decelerating** (retryWarns 6→20→72→186; overall power-law
  exponent ~2.1). The deceleration at 5→10u and the vote loss share ONE cause: the
  fixed `DEFAULT_RETRIES_FOR_EVENTS=5` ceiling — past it, events stop retrying and
  drop instead of re-contending.
- **Keying fixes A, NOT C.** `indexed` (flat 68-node graph) contends *byte-identically*
  to `array` (same retryWarns/exhaustions/drops). So fixing the graph blowup un-blocks
  the keyed path only to ~5 users; at 10u it hits C and silently drops 40%.
- **Silent drops are a GENERAL runtime behavior, not SQLite-specific.** Cold-verified:
  `indexed` at 3×10 reads **18/30 in canonical storage** (cold == live == 18) — 12
  real lost writes on a plain cell variant. So any high-contention shared write hits
  this; SQLite just crosses the threshold sooner.
- **Drop threshold ≈ halves with each added/wider contention point:** cells drop at
  ~10u; plain `sqlite` (handle.rev funnel + wider commit window) by ~5u (cold 6/6 @2u,
  9/9 @3u, 1 @5u); `sqlite-rev` (a *second* shared RMW, line 272) by ~2–3u (cold 3/6,
  4/9). **Both levers matter** — funnel *count* (sqlite-rev < sqlite) AND commit-window
  *width* (sqlite < an equivalent cell). (The workflow first over-credited the funnel
  count alone; the sqlite-vs-cell threshold gap shows the window matters too. Low-conc
  cold counts are N=1 with high variance — treat magnitudes as estimates, direction as
  solid.)
- **The drop is even quieter than "exhaustion."** At indexed 3×10, 12 votes drop but
  only **6** `exhausting all retries` lines — ~half the lost writes log *nothing*.
  Mechanism for the unlogged residual unidentified (open).

**Still model-only (project-distrusted):** the per-row exhaustion → specific missing
`(voter,option)` mapping, and the unlogged-residual mechanism. The events.ts:663
counter instrumentation remains the definitive close.

**Byproduct bug (separate from perf, real):** `CloneForMutationError`
(`cannot mutate null`) in `storage/v2.ts applyPendingVersion` → `value-clone.ts`.
Deterministically crashes the `array` 3×2 join phase; spreads to more workers under
load (user-2 then user-9 at 3×10). Exit code stays 0 (`results[].ok=false`) — harness
exit-code blindness. Data-integrity hazard for any array-variant sweep.

### Root cause grounded + residual RESOLVED — 2026-06-16

Structural grounding (multi-agent code read + adversarial verify) + direct
instrumentation. Full team-facing writeup: **`DROPPED-WRITES-EVIDENCE.md`**.

- **Conflict unit = the entity-DOCUMENT** `(branch, id, scope_key)`, server-side.
  The governing predicate `SELECT_SET_DELETE_CONFLICT` (`memory/v2/engine.ts:529`)
  has NO field/path/space column. So: distinct keys in one Record collide (keying
  doesn't help — `cell.ts:1492-1521`, `data-updating.ts:838-902`); disjoint cells
  don't (distinct ids; `scope` "space" → constant `DEFAULT_SCOPE_KEY`,
  `engine.ts:46-53`). Retry budget 5 (`scheduler/constants.ts:5`); commit is
  fire-and-forget (`events.ts:609-616`) so the drop is **silent to the caller**.
- **The "unlogged residual" (12 missing > 6 exhaustions) is RESOLVED — it is a
  CASCADE of the same bug, NOT a second mechanism.** `joinAs` writes the contended
  `usersByName`/`userOrder` docs AND `myName` (`PerUser`) in one tx
  (`main-indexed.tsx:156-177`); a dropped join takes `myName.set()` with it →
  empty `myName` → `castVote`'s guard `if (!me) return` (`:246`) silently no-ops
  that user's votes. Instrumented: **9 `castVote`s fired with `me=""`** at 3×10.
  So the "extra" missing votes were never *attempted* as writes; their root drop
  was logged at the *join* phase, not the vote phase.
- **Two hypotheses REFUTED** by a minimal SQLite-free repro
  (`write-contention/repro.tsx`): the shared-subrecord write *shape* (minimal
  `tally.get()` + `key().set()` → `missing == exhaustions`, no silent loss) and the
  multi-bucket *structure* (buckets 1/2/3 all clean). This supersedes the
  line-90 `sqlite-rev` lost-update guess.
- **`events.ts:663` counter instrumentation is no longer needed** — the cascade
  (not a hidden silent path) explains the residual; the per-row exhaustion mapping
  is moot.

### Cross-cutting insight (bridges this session's earlier work)

The vote-read failure is the **same SQLite-query cross-runtime reactivity gap**
seen earlier this session: `recentVisits` only resolved under a subscribed
browser runtime, never headless CLI (`reactOn: db` staleness + no cross-runtime
propagation). Array/indexed *cells* propagate correctly (votes=15); SQLite query
reads do not. **So raw SQLite pushdown is NOT a drop-in for live multi-user
reactive reads** — it needs the finer invalidation + cross-runtime propagation
that wilk flagged as runtime work. SQLite wins on graph (and *maybe* contention),
but loses on reactive read propagation as it stands.

## Remaining agenda (resume here)

1. ~~**Resolve the Phase-2 confound.**~~ **DONE 2026-06-15** — see "open confound
   — RESOLVED" above. Cold-reader probe (`probe-sqlite-landing.ts`,
   `addColdSession`) proves **writes dropped** (1/15 in storage; 14 castVote
   txns exhaust retries on the shared handle `rev`). SQLite-as-written is worse
   under concurrency, not better; the diagnose "7 retries" under-counts.
   **Re-validated 2026-06-16 on rebased main** (see "Re-validated on rebased main"
   above): holds in full, mechanism upgraded to `structural+measured`. `sqlite-rev`
   drops the same 1/15 as plain sqlite — **floor saturation**, so it does not
   separate the `rev`-funnel from the SQLite write window.
   _Definitive close (only model-only residual left):_ instrument a counter at the
   `events.ts:663` exhaustion log and assert it fires ~14× per 3×5 sqlite run AND
   maps each exhaustion to a specific missing `(voter,option)` row — converts the
   silent-drop link from inference/conservation to a fired-counter proof.
2. **Phase 3 — characterize C.** Retry counts vs user concurrency (e.g.
   `--cases=3x2,3x5,3x10`) for array/indexed; confirm the super-linear curve and
   whether it's the next wall after A is fixed.
3. **Phase 4 — B is separable.** Defer/lazy the per-option image/search/LLM off
   the load path (independent of A/C). Note: even `--skip-refresh` leaves the
   per-option enrichment *computeds* in the graph (hot `topReadSites` clustered
   on `homePageSearch`/`displayHomePageUrl`), so structural deferral matters, not
   just skipping the fetch.

## Files created this session (in this worktree, branch `perf-investigation`)

- `main-sqlite.tsx` — diagnostic variant: `main-indexed.tsx` with ONLY the vote
  storage swapped to a SQLite table (per-row `INSERT OR REPLACE`, `reactOn: db`,
  no shared votes cell). Isolates the vote-write mechanism.
- `main-sqlite-rev.tsx` — same, but `reactOn: sqliteRev` (a counter bumped in
  `castVote`) to test reliable reads + whether the counter reintroduces
  contention.
- `probe-sqlite-landing.ts` — step-1 cold-reader probe. Drives join → options →
  concurrent vote rounds, then cold-opens a fresh runtime to read canonical
  server SQLite truth (writes-landed vs writes-dropped). Run:
  `deno run -A packages/patterns/lunch-poll/probe-sqlite-landing.ts --program=main-sqlite.tsx --case=3x5 --rounds=3`
- `../integration/multi-runtime-harness.ts` — **modified** (reusable): added
  `spaceName`/`apiUrl` fields + `addColdSession(label, identity?)` to spawn a
  post-hoc runtime that opens the piece fresh. Disposed with the harness.
- `PERF-SESSION-2026-06-15.md` — this doc.

## Lunch-poll feature work status (separate from perf)

- #4144 (SQLite history migration) — **merged** to main.
- #4145 (`gideon/lunch-poll-freetext-join`: free-text join + Lunch Stats
  per-place + yellow tally + docs) — **open**, rebased onto main, mergeable,
  cubic's 3 review comments all addressed. CI running after the `deno fmt` fix.
- `cf-feat-1/labs/packages/patterns/lunch-poll/perf.test.tsx` — untracked scratch
  perf probe (single-user graph-scaling); keep as a guard or delete.
- Live prod piece: `toolshed.saga-castor.ts.net/team-lunch/fid1:zJT0…` (free-text
  join + stats fixes deployed via `setsrc`). Deploy key at `labs/prod.key`.
