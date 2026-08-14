# v2 verification: coverage register — the stopping criterion

**Verification instrument, NON-NORMATIVE** — the closing audit of
the spec-time verification arc. Every BINDING rule (MUST / NEVER /
FORBIDDEN / closed-set / RULED semantics) across the ten governing
docs was enumerated (2026-08-03, four mapping agents + adjudication)
and assigned to the instrument that checks it — or to an adjudicated
reason none does. The claim this register makes: **no binding rule
is unverified by accident.** When that claim stops holding (a new
rule lands without a row here), this file is stale and the next
mapping pass is due.

## 1. The map

297 binding rules. Instruments: the scenario traces (T1–T12), the
field-provenance chains, the executable model (C1–C10 property
families), the Phase 1 dry-run, and the doc-review panels
(weak — counted only where nothing else applies).

| doc | rules | instrument-covered | impl-gate | deferral | derivable | owed |
| --- | --- | --- | --- | --- | --- | --- |
| README | 31 | 17 | 9 | 1 | 2 | 2* |
| protocol | 59 | 45 | 6 | 3 | 4 | 1* |
| events | 34 | 25 | 4 | 2 | 2 | 1 |
| scopes | 25 | 17 | 3 | 1 | 2 | 2 |
| builtins | 15 | 6 | 3 | 1 | 4 | 1 |
| serving-loop | 77 | 45 | 20 | 1 | 5 | 6 |
| key-vocabulary | 9 | 5 | 3 | 0 | 0 | 1 |
| speculation | 16 | 11 | 2 | 0 | 1 | 2 |
| testing | 14 | 4 | 10 | 0 | 0 | 0 |
| runtime-mapping | 17 | 5 | 3 | 1 | 5 | 3 |

(*push-priority appears in two docs — counted once in §3. The
scheduler-tell classification rule likewise appears in two docs —
protocol §1 primary, speculation §2 cross-reference — and is counted
once, under protocol.)

**Adjudication notes on the three big buckets:**

- **Implementation-gate (~56 rules)** is not a hole — it is the
  HANDOFF. These rules bind code and CI, not prose: the stage-C
  deletion lists and golden regeneration, the amplification budget,
  the harness MUSTs (testing.md §1 is gates about gates), the
  transformer lints, no-static-analysis, flag registration, the §8
  grep tripwires. Their verification home is the stage PRs and the
  `sx2-` surface (testing.md §5); each stage's pre-flight should
  pull its rows from this register.
- **Deferral (~9)**: explicitly deferred semantics (streaming,
  quota attribution, session-data GC, basis-row retention bound,
  resume-republish end state). Deferrals are answers.
- **Derivable (~24)**: follows from a covered rule; each mapping
  run named the covering cell. Spot-checked in adjudication.

## 2. Verified-by-instrument highlights (what "covered" means)

The identity/commit core is now checked three ways deep: envelope vs
annotation identity (traces T1–T5, provenance clusters A–C, model
C1–C3), the lease including DR1's fence and its residue (C6/C7),
mid-wave conflict classes and exactly-once (C8–C10, T9), crash
recovery and the FP1 closure (T10, C2-FP1), push filtering and
settledness (T1/T4/T6, C4), the effect channel with LT8's window
(T2, C1-LT8), cross-space carriage end to end (T4, cluster B,
C2/C2-dedupe).

Delta 2026-08-04 — the consequence-flush deadline (serving-loop
§3): both new binding sentences are covered without a new
instrument. The flush SEMANTICS (commit-early, W pinned,
continuation completes, exactly-once across the boundary) are
trigger-agnostic and C10-verified — the clockless model's count
budget is the deadline's proxy — and the sealing-order MUST is the
same property family (C1/C10's event-first processing). The
`T_flush` VALUE is a Phase 6 implementation gate alongside the
other budgets. The recorded write-class fallback is not built —
no instrument owed unless it is ever adopted.

Delta 2026-08-04/05 — stage D's carriage sentences and the
2026-08-05 ruling pair (protocol 53 → 58):

- §7's stored-representation sentences (the annotation pair's
  carriage is server-internal admission input; its stored form is a
  per-op-indexed sidecar on the commit row — recorded, never wire,
  never pushed; admission consumes only the addressing half): +2
  rules, impl-gate, verification home = the stage-D PR's engine
  tests (`packages/memory/test/v2-wave-commit-test.ts` pins the
  stored pair, the addressing-keyed rows, the
  space-scoped-annotation refusal, and the non-derived refusal).
- §1's `system`-row widening (RULED 2026-08-05): the
  new-direct-write-caller-is-a-spec-decision sentence is
  panel-covered (+1 instrument-covered — a prose-discipline rule,
  the same instrument family as §7's "spec edit here first"); the
  accepted no-user-attribution posture with its named blob-write
  hardening is a deferral (+1) — deferrals are answers.
- §2's derived-envelope defense-in-depth sentence (RULED
  2026-08-05): +1 rule, impl-gate, assigned to Phase 1 stage F —
  the plan's stage F bullet carries the task. The MODEL side needs
  no extension: `admitDerived` already compares the envelope
  principal to `holderId`; the impl-side operand mapping is the
  stage F design question.

The same review recorded a model/impl asymmetry in §3d's conflict
handling — the impl's three-way drop/rebase/requeue disposition is
pinned by impl tests only — now owed as OW9 below.

Delta 2026-08-05 — the stage-D review's Q1/Q2/Q4 ruling batch
(serving-loop 71 → 76):

- Q1 (§3d recompute-by-dependency, RULED 2026-08-05): the weakened
  recompute sentence is a CHANGED rule, model-covered as before —
  C8a's recompute flows through the model derivation's own read of
  the raced doc (its fire predicate consults the output's current
  value), and the model has no drop-triggered re-arm mechanism, so
  it verifies exactly the ruled semantics. Two NEW rules: the drop
  re-arms nothing / no recompute-owed mark exists (+1,
  instrument-covered, the same C8a family); a survivor whose writes
  were dropped per-doc still lands its basis rows (+1, impl-gate —
  the mixed-disposition test in
  `packages/runner/test/executor-wave.test.ts` asserts the
  dropped-write survivor's rows land).
- Q2 (per-run write classification, RULED 2026-08-05): +1 rule,
  instrument-covered — the model's C8 contributions carry writes per
  producing run, and the impl's per-(contribution,doc) disposition
  test pins one handler write rebasing while a derivation's write to
  the same doc drops.
- Q4 (unstamped seals refused, RULED 2026-08-05): +1 rule,
  impl-gate — the refusal throw at the seal destination is pinned
  red-first in `packages/runner/test/executor-wave.test.ts`; the
  stage-F half (naming the sanctioned internal stamp kinds when the
  seal destination is installed) is +1 impl-gate assigned to Phase 1
  stage F, alongside §2's derived-envelope check.

Delta 2026-08-05 (follow-up) — Q1-ruling propagation (serving-loop
76 → 77; no other rows move):

- The retracted unconditional "next wave recomputes" sentence
  survived outside §3d — protocol §1 (threat model) and §2
  (admission note), README §1, runtime-mapping N15/N17 — and two
  trace cells (T9.Q1, T12.Q4) had drifted. All now state the
  dependency-only rule and cite serving-loop §3d (RULED
  2026-08-05). CHANGED sentences only: every location keeps its
  existing row; no counts move for these.
- Completion-path clarification (adjudicated 2026-08-05, vetoable):
  the completion commit (serving-loop §4) never passes §3d's
  sealing, but its identity annotations are sourced from outbox
  carriage captured at the ORIGINAL run's seal — necessarily
  stamped under Q4's refusal — so completion commits inherit
  stamped provenance transitively and no unstamped derived path
  exists. +1 rule, DERIVABLE — covering cells: the Q4 refusal row
  (impl-gate, above) and §4's identity-carriage miss rule (FP6,
  RULED 2026-08-03).

Delta 2026-08-05 — the name-keyed boundary surface
(key-vocabulary §5, stage E's review batch): three new rules
(key-vocabulary 6 → 9). The §4 tripwire extension (a new
name-keyed identity key, or a change to a listed boundary site,
must update §5) is an implementation gate of the same grep-tripwire
class as the rest of §4. The coverage-memo enablement gate
(unscoped-link coverage stays off until the html reconciler's
`get({ traverseCells: true })` value consumption is resolved —
key-vocabulary §5) is an implementation gate on the PR that flips
it. The schema-memo single-identity invariant (cross-identity memo
sharing FORBIDDEN) is OWED an explicit guard — OW10.

Delta 2026-08-05 — stage F lands (the serving loop; this PR):

- §2's derived-envelope defense-in-depth row: impl-gate → COVERED.
  The operand mapping landed (`resolveCommitSessionKey(sessionId,
  principal) == holder` — the sink commits under the holder's own
  service session) with negative tests
  (`packages/memory/test/v2-wave-commit-test.ts`: a user session and
  a non-holder internal session naming the right holder are both
  refused; the holder's own session admits). protocol.md §2 records
  the landed mapping — a CHANGED sentence, same row.
- §3d's stage-F stamp-kind naming duty: impl-gate → COVERED. The
  sanctioned internal kind is named (`bookkeeping`, serving-loop.md
  §3d — a NEW binding sentence, this row is its coverage), stamped
  at the three scheduler/runner choke points, with BOTH conflict
  dispositions pinned in
  `packages/runner/test/executor-wave.test.ts`: a bookkeeping PATCH
  racing a disjoint authored patch REBASES and commits (the live
  rebase arm — the loop's steady-state watermark advance is a
  key-path patch), and a semantic conflict (whole-doc authored
  intrusion) DROPS the contribution whole with nothing requeued.
  The drop arm's recorded acceptance, stated truthfully
  (2026-08-05): the wave's commit metadata (`derivedThrough`) and
  the loop's in-memory W still advance when the DOC write drops —
  the doc lags until the next INPUT-driven advance (a quiet space
  stays lagged), which is conservative for clients because
  `waitForSettled` reads the doc. Accepted under protocol §1's
  authored-intrusion threat model; the code comments at the
  bookkeeping write and the WaveRunKind doc state the same.
- §2's read row (LD5): the admission half is now impl-covered —
  `packages/memory/test/v2-explicit-read-test.ts` pins
  holder-admitted / non-holder-refused / off-flag-refused on both
  the query and watch paths. The trace/model coverage stands
  unchanged. One recorded Phase-1 acceptance rides this row
  (2026-08-05): the landed operand check compares the
  SERVICE-IDENTITY component of the live holder, not the full
  per-process DR1 holder, so a second process sharing the service
  DID would pass on the first process's lease row — no instances
  exist co-hosted in Phase 1 (one serving process per memory
  server); the per-process sharpening lands with Phase 5's
  cross-engine lease lookup design, alongside FP2's widening.
- serving-loop §2's renew cadence + stop-committing MUST: the
  serving loop drives them for real; lease-loss and idle-park pinned
  end to end in `packages/runner/test/executor-serving-loop.test.ts`
  (C6/C7's impl witnesses at the loop level) — including the
  renew-blip arm (2026-08-05): when the reacquire SUCCEEDS but a
  wave sealed under the lapsed tenure aborts at its commit step, the
  space PARKS rather than continuing (a continued loop would mint a
  watermark-only advance over the withdrawn derivations;
  re-activation's fresh-runtime recompute-on-demand is the only
  post-abort arm), pinned with a deterministic mid-wave interleave.
- serving-loop §6 step 2's re-mark: PARTIAL by design in Phase 1 —
  activation runs `selectStaleBasisInstances` and surfaces the stale
  set (counted, logged), and recovery CORRECTNESS rides
  recompute-on-demand over a fresh runtime (sound: an absent warm
  graph means demanded pulls recompute regardless). The
  skip-still-current warm-start VALUE of the index materializes when
  a later stage carries a materialized graph across activation;
  until then the scan is the recovery input, not yet an optimizer.
- protocol §4's watermark: impl-gate rows land — the doc + metadata
  carriage (`derived_through`), same-transaction watermark write,
  W-advance-at-quiescence-only, and `waitForSettled` — pinned in the
  serving-loop tests.
- scopes §2's eager via-user hop: impl-gate → PARTIALLY COVERED
  (`packages/runner/test/eager-via-user-hop.test.ts`: both
  `data-updating.ts` shapes — the declared-scope narrowing and the
  eager omitted-property redirect — under the flag, one hop pinned
  in the OFF arm). The DISCOVERED-narrowing site
  (`pattern-binding.ts`'s `narrowestReadScope` branch) carries the
  same gated chain but has no direct test yet — owed as OW12 below.
- key-vocabulary §5's boundary re-keys (M4-coupled + serving-identity
  lists): dispositions moved to RE-KEYED in the same change, per §4's
  tripwire; the server-side partition equivalence is witnessed by the
  full memory suite (wire frames byte-identical via `toWireUpsert`)
  and the client-side by the full runner suite. TWO RECORDED
  OFF-arm acceptances ride this row, both RATIFIED (owner,
  2026-08-05; testing §2's byte-identity gate now carries the
  matching "up to the recorded key-vocabulary §5 acceptances"
  clause):
  - the `fromSeq` resume-marker delta — the M4 re-key removes the
    cross-session SPURIOUS WAKE the name-keyed form produced
    (principal A's scoped commit no longer re-evaluates principal
    B's session), so under multi-principal scoped workloads a later
    frame's `fromSeq` can differ from the old arm's. No client
    consumes server-frame `fromSeq` (an unconsumed integer); the
    observable residue is a marker-latency shift of roughly the
    refresh cadence (~5 ms) in the staged-ack race window, and the
    removed wake is the M4 defect itself.
  - the shaper-bucket merge — the `${scope}:${id}` normalization
    merges the two buckets that previously DISAGREED about one
    piece's identity (`packages/runner/src/runner.ts:3399–3417,
    5450–5456`; key-vocabulary §5's parenthetical carries the same
    ratification stamp).
- stage D's documented bounds: the delegated-admission bound is
  DISCHARGED for its LANDED half only — carriage presence +
  completeness (authored class, non-empty actor + grant, the
  sessionless session-scope refusal) and carried-identity keying,
  pinned in `executor-wave.test.ts` and
  `packages/memory/test/v2-wave-commit-test.ts` — while grant
  RESOLUTION against the target doc/stream remains OWED hardening
  (OW13 below; protocol §2's delegated row carries the same
  Phase-1-bound parenthetical). The read-only-read-set bound is
  DISCHARGED with tests (read-only reads folding into withdrawals).
  The sqlite bound stays stage G.

Delta 2026-08-05 — the stage-F independent review's ruling batch
(three flags RULED by the owner; changed sentences and recorded
acceptances only — no rule counts move):

- Flag 1 (the `inputSynced` input-barrier residual — a frame parked
  on the loop's own sealed commit vs foreign novelty): ACCEPTED for
  Phase 1, revisit trigger Phase 2. The two named revisit items —
  the parked-on-own-seal distinction (or excluding unapplied frames'
  seqs from `batchHead`) and the pattern-updater CHECK-half
  verification in the `sx2-serving-loop` integration surface — are
  carried in the plan's Phase 2 section so its gates cannot rely on
  W before they resolve.
- Flag 2 (watermark-only derived commits): CONFIRMED — protocol §4's
  "never its own commit" now carries the ruled parenthetical: an
  advance-only wave commits the advance as the batch's ONE derived
  commit; the phrase bans bookkeeping-as-its-own-commit (the
  push-priority rule), not advance-only waves. CHANGED sentence,
  same row.
- Flag 3 (OFF-arm byte-identity deltas): RATIFIED — testing §2's
  gate sentence now reads byte-identical "up to the recorded
  key-vocabulary §5 acceptances", and the recorded-acceptance row
  above names both deltas.

Delta 2026-08-06 — stage G lands (effect serving + the outbox; this
PR):

- serving-loop §4's memoization contract: impl-gate → COVERED. The
  hit rule, in-flight dedupe, error-shaped results, and the
  no-re-fire-on-recovery property are pinned end to end in
  `packages/runner/test/executor-serving-loop.test.ts` (the effectful
  node journey: one external call per key across park/re-activate;
  the failure leg retries only on input change) and
  `packages/runner/test/executor-outbox.test.ts` (dedupe + counters).
  The builtins' own memo checks now REPORT hits (`effectMemoObserver`
  — fetch*, generate*, sqliteQuery; fetchProgram and llmDialog count
  misses via the outbox and report no hit events yet, recorded in
  stats.ts).
- serving-loop §4's completion-commit clarification (2026-08-05,
  was DERIVABLE): now impl-covered — the completion commits as its
  OWN derived-class commit (never through §3d's sealing), its
  annotations sourced from the outbox carriage captured at the
  original run's seal, pinned with a scoped write + acting identity
  in `executor-serving-loop.test.ts` (T7.Q4's impl witness). Stated
  for Phase 1: T7.Q4's carriage-sourced `scope_key` is STRUCTURAL —
  the E2E pins the cardinality-1 fallback (carriage identity ==
  wave identity), and the per-run demanded identity that makes the
  carriage carry a DIFFERENT key arrives with Phase 2's stamper.
- serving-loop §5's FP1 rows: impl-gate → COVERED. Durable rows
  land INSIDE the wave's engine transaction (surviving contributions
  only — a dependency-dropped contribution's appends are excluded, a
  per-doc-superseded survivor's still ride, matching §3d's
  drop-re-arms-nothing ruling), delivery admits at the target under
  the delegated row with `firedAt` from the CARRIED actor (LT5's
  service envelope), the row deletes on delivery-ack
  (admit-before-delete), a re-sent duplicate dedupes at the eventId
  horizon, and an LT4 deterministic rejection deletes without
  retrying (`executor-outbox.test.ts`; the model's C2/FP1 closure
  stays the oracle).
- serving-loop §1 plane (c): CHANGED sentence — the direct-engine
  plane now also carries the outbox's delivery-acked row retirement
  (the rows are WRITTEN on plane (a) inside the wave transaction;
  only the delete rides plane (c)). This row is its coverage; the
  retirement behavior is pinned by the delivery tests above.
- serving-loop §7's memo/outbox counters: structurally-zero note
  retired — the counters are live and asserted by the stage-G tests
  (stats.ts documents the exact semantics, including that
  `outbox.failed` counts INFRASTRUCTURE failures while effect-level
  failures commit error-shaped results per §4).
- stage D's last documented bound (sqlite ops in wave batches):
  DISCHARGED for HOME batches — the accumulator resolves each folded
  op's db scope against its RUN's identity (M1), the sink attaches
  through the memory server's `attachWaveCommitSqliteDbs` (same
  validations as the transact path) and applies atomically inside
  the wave transaction; hook-less sinks, key-less ops, and FOREIGN
  batches with sqlite ops are refused loudly (`executor-outbox.
  test.ts`). Foreign-batch sqlite lands with Phase 5's cross-space
  design.
- OW7 → LANDED as trace T14 (scenario-traces §3/§4) plus the
  serving-loop failure-leg test above; the owed entry below is
  flipped.
- The stage-G adversarial review's fix batch (2026-08-06), coverage
  where it added binding behavior: (i) the deferred-flush window the
  serving posture opens — a stale action re-run re-admitting a key
  whose first effect already completed — is closed by TWO mechanisms
  in series, stated truthfully after the independent review's
  captured double-fire showed the claim guard alone does NOT close
  it: `tryClaimMutex`'s completed-request guard (skip the claim when
  the stored hash matches and a result/error is READABLE —
  unit-pinned in `fetch-claim-takeover.test.ts`) plus the
  READABILITY-GATED in-flight retirement (serving-loop §5's ruled
  idempotence sentence): the outbox holds the key until every
  completion commit's writes are applied to the serving replica
  (`ISpaceReplica.whenApplied` over CT-1927's parked accepts), so
  the stale re-admit that used to arrive inside the ~15 ms
  absorption window — reading a view without the completion, where
  the guard structurally passes — now DEDUPES. Pinned by the
  `whenApplied` unit (`memory-v2-stacked-commit.test.ts`), the
  deterministic hold-absorption/re-admit/dedupe interleave
  (`executor-outbox.test.ts`), and the E2E's exactly-once
  external-call pins under repeated load runs; (ii) the sqliteQuery
  memo decision distinguishes a SETTLED result (a hit) from a bare
  claim marker — an orphaned claim re-issues under the serving
  posture only (`sqliteQueryMemoDecision`, unit-pinned), restoring
  §6 step 3's re-miss premise for the one builtin whose key commits
  ahead of its result; (iii) userless/grantless outbound appends
  are refused at the SOURCE (`enqueueOutboundAppend`), fail-closed
  ahead of the delegated floor that would deterministically destroy
  them at delivery — the Phase-3 floor carve-out for sessionless
  space-scope emissions is now SHAPE-RULED (2026-08-05, protocol §2;
  implementation is Phase 3's, owed below); (iv) admit-before-delete
  is now pinned by a transport-failure test (the row survives a
  non-deterministic delivery failure; the next drain delivers
  exactly one entry).

Delta 2026-08-06 — the stage-G INDEPENDENT review's fix batch, plus
the owner's 2026-08-05 ruling batch (five rulings recorded; changed
sentences, one recorded acceptance, three owed entries):

- serving-loop §5's effect-idempotence sentence: AMENDED (RULED
  2026-08-05). The old "a duplicate completion writes an identical
  key and is a CAS no-op" described a mechanism the completion path
  does not have; the section now states the true one — the
  builtins' request-hash guards plus the all-no-op short-circuit,
  completion commits deliberately at `basisSeq = NOW` (no per-doc
  CAS), and the readability-gated in-flight retirement closing the
  absorption-window race. CHANGED sentence; its coverage is the
  fix-batch row above.
- serving-loop §3d's sanctioned-stamp-kinds sentence: the
  "acked-effect retirement when stage G lands it" clause was a
  MIS-ATTRIBUTION (reviewer-verified): the write it describes is
  Phase 4's client-effect retirement (protocol §5 — a
  bookkeeping-stamped wave write among protocol §1's
  service-identity writes). §3d now attributes it to Phase 4 and
  notes stage G's own retirement is plane (c)'s unstamped
  engine-table ROW delete (§1 already said so). CHANGED sentence,
  same rows.
- ONE RECORDED OFF-arm acceptance rides stage G (RATIFIED
  2026-08-05; testing §2's gate clause widened the same day to name
  this register's recorded-acceptance rows alongside
  key-vocabulary §5's): `tryClaimMutex`'s completed-request guard
  changes the OFF arm's cross-writer race corner. Old behavior:
  a claimant racing another writer's completed result for the SAME
  inputs claimed anyway, transiently cleared result/error, and
  re-fetched (a redundant refetch plus a visible clearing blip).
  New behavior: the claim is skipped — the stored value stands.
  Post-B-1 shape, stated precisely: the guard reads the claimant's
  view, so it engages exactly when the completed writeback is
  READABLE there; the serving posture's unreadable-window case is
  closed by the retirement gate (above), not by this guard, and
  client-side the guard only removes the redundant-refetch corner
  (inline flushing already made in-process ordering safe). (A SECOND
  recorded acceptance — Phase 2's R4 written-subtree narrowing — is
  recorded in the Phase-2 independent-review delta below.)
- FP6's register row (field-provenance.md): the label basis is
  STRUCTURAL, not frozen (RULED 2026-08-05) — tightening mid-flight
  yields the stricter label, loosening matches the OFF arm's
  write-time derivation, a frozen snapshot would write stale labels
  over a re-labeled basis. Recorded on the row; no mechanism moved.
- protocol §2: the Phase-3 floor carve-out for sessionless
  space-scope emissions is SHAPE-RULED (2026-08-05) and recorded in
  the delegated-row region — absent acting principal admitted iff
  declared sessionless-space-scope (`firedAt = { session: "server"
  }`, no user key), grant presence still mandatory. events §2 and
  the model already carry the semantics; implementation is owed
  (Phase 3, below).
- builtins §2's fetch row: the "migrate requestHash onto the result
  doc" prescription now carries its deferral note (the
  internal-cell hash is functionally equivalent committed state per
  T10.Q1; the migration is an OFF-arm cell-shape change waiting for
  an OFF-arm ruling batch that wants it — plausibly never).
  CHANGED sentence, same row.
- stats.ts's memo.hits note now states the hit unit (a
  re-evaluation touching a settled effect node, NOT a suppressed
  fire) so Phase 2's gate arithmetic cannot read hits as "avoided
  calls". Code-comment clarification; no counter moved.
- FP1 fold completeness (the review's M-A): appends and consequence
  coverage now fold for EVERY surviving contribution — the
  foreign-only-seal survivor and the zero-seal emitter (minted as a
  zero-write contribution, the model's committed-`writes: []`
  shape) both land their appends and `consequenceOf`; both shapes
  red-first pinned in `executor-outbox.test.ts`.
- The SpaceServer's recovery seams (the review's M-B): the §6-step-5
  activation re-send and the owed post-wave drain are now pinned at
  the SpaceServer level (`executor-space-server.test.ts` — deleting
  the activation re-send call turns the test red), and a
  transport-failed ACTIVATION re-send now arms the owed re-drain so
  surviving rows ride the next wave instead of waiting for the next
  appends-carrying wave or re-activation.

Delta 2026-08-07 — the completion-visibility wedge fix batch (F1a +
F2, mechanism-triaged from the serving-loop soak's ~11%-red wedge
population):

- Retirement LIVENESS (F1a): sealed commits — waves and effect
  completions alike — now CONFIRM on the serving replica at verdict
  time (`settleSealedCommit` → `confirmPending`) instead of taking
  the parkable path. Parking guards a REMOTE mirror against
  promoting over missing foreign novelty, but engine-plane commits
  bypass the transact path — the only place catch-up marker
  obligations are staged — so a parked sealed accept could NEVER
  promote: `whenApplied` waiters never resolved, every served
  effect leaked one permanently-in-flight outbox entry, and any
  A→B→A input cycle starved deduping against the dead entry.
  CT-1927 parking for pushed (socket) commits is untouched. The
  earlier fix-batch row's "whenApplied over CT-1927's parked
  accepts" mechanism reads accordingly: readability is now
  immediate for completions and the retirement barrier is the BELT
  over the structural guarantee (its hold/re-admit/dedupe pins are
  unchanged and still green). Red-first pinned by the deterministic
  A→B→A starvation test and the N-effects in-flight-baseline test
  (`executor-serving-loop.test.ts`).
- Completion writebacks are AUTHORITATIVE (F2): a completion-marked
  transaction's writes commit even where the replica's optimistic
  view calls them no-ops — that view can layer a DOOMED sealed
  overlay (a derivation write a later wave-commit supersede-drops,
  §3d), and eliding the completion's `inputHash`/`pending` writes
  against it durably landed `result present + inputHash stale`,
  which the next run's memo guard read as "inputs changed" and
  destroyed the just-served value (the observed ~30 ms
  arrive-then-wipe). Mechanism: `markEffectCompletion` flips the
  transaction into authoritative-writes mode
  (`markAuthoritativeWrites`, gated on the serving posture's seal
  destination so the OFF arm stays byte-identical), which is
  honored at every elision layer — the value-diff leaf
  (`normalizeAndDiff`), the transaction write paths, the doc-level
  no-op skip and the initial-vs-current patch diff
  (`getNativeCommit`/`buildPatchOperation`, which emits forced
  full-cover `replace` asserts). All effectful builtins already
  route their writebacks through `markEffectCompletion`
  (fetch/fetch-program/llm/llm-dialog/sqlite), so the audit
  reduces to that single seam. Ordinary transactions keep the
  elision everywhere. Red-first pinned by the torn-hash
  supersede-drop interleave (`executor-wave.test.ts`).
- The parked-overlay stale-read machine (the triage's independent
  observation — a never-promoted sealed overlay replaying over
  advancing confirmed state until a later drop flips visible
  state): structurally unreachable post-F1a — sealed verdicts
  either confirm immediately or withdraw-and-roll-back, and
  `settleAccept`'s parking branch is reachable only from the
  socket-transact paths, where CT-1927's marker machinery
  guarantees eventual promotion. No test forced; recorded here.

Delta 2026-08-07 — Phase 2 lands (flag ON: the server derives, the
client does not; this PR):

- speculation §1/§2/§4/§6's impl-gate rows: → COVERED. The overlay is
  the runtime's DEFAULT seal destination under the flag for every
  non-serving runtime (`packages/runner/src/speculation/
  overlay-destination.ts`): stamped derivation-kind runs redirect into
  the replica's pending layer (`sealNative` speculative — outside the
  `synced()` barrier), handler runs keep committing authored (F10),
  unstamped/binding writes untouched, egress effect kinds dropped
  with `navigateTo` enacting (the egress rule), `compile-and-run`
  gated at the builtin — the gate's true interim scope is wider than
  "not speculable": it suppresses fresh compiles for EVERY flag-ON
  non-wave run and the serving side refuses the writebacks, so fresh
  compile-and-run is INERT ON-arm until the serving port (stage G's
  out-of-scope note) lands; both-arms pins in
  `packages/runner/test/compile-and-run.test.ts` (the review's m5) —
  retirement on watermark coverage of the entry's read basis + acked
  origins via success-shaped `superseded` withdrawals that cascade
  nothing. Pinned in
  `packages/runner/test/speculation-overlay.test.ts` (echo with zero
  client commits; the store-attribution query — zero derived-class
  commits from any client session; watermark-coverage retirement;
  F10; egress suppression) and live in
  `packages/patterns/integration/sx2-speculation.test.ts` — scoped
  honestly (the review's m6): the acked-origins component (§4 step
  3's KEEP half — an unacked origin holds the echo) is NOT directly
  pinned by these suites; it rides OW4's scoping below, with direct
  pins owed alongside the Phase-3 offline machinery that builds the
  origin-queue fixtures they need.
- The Phase-2 revisit (a) — the settle input barrier: RESOLVED by the
  plan's sanctioned exclusion alternative.
  `ISpaceReplica.unappliedForeignSeqFloor` reports inbound foreign
  seqs still shadowed by parked own writes; the SpaceServer clamps
  its W advance below them (`watermarkClamped` counter, serving-loop
  §7 — edited with this delta) and the shadow-flip notification in
  `confirmPending` (flag ON) registers the dirtiness the moment the
  overlay leaves, so the next wave derives over the foreign value
  before W claims it. Two exemptions the serving loop's own frames
  forced, both pinned: an own-echo upsert (its seq IS a pending
  accept's ack seq, with the verdict-race repair) and the seq-0
  absent-doc marker never shadow. Pinned in
  `packages/runner/test/memory-v2-stacked-commit.test.ts` (flag-ON
  shadow + flip notification; flag-OFF silent-flip byte-identity;
  own-echo exemption). The stage-F residual comment at `inputSynced`
  is rewritten to the resolved posture.
- The Phase-2 revisit (b) — the pattern-updater CHECK half: the
  `sx2-serving-loop` integration surface is AUTHORED
  (`packages/patterns/integration/sx2-serving-loop.test.ts`) and the
  machinery observation was made in the live bring-up runs (the
  serving loop settles to watermark-covered quiescence with
  `systemPatternAutoUpdate` flipped ON server-side against toolshed's
  real routes — the environment the stage-F unit fixture could not
  provide). Stated honestly: that surface is currently SKIP-LISTED in
  the ON arm (it deterministically reproduces the demand-cycle
  starvation fork — the owed row below), so its gates are witnessed
  by the live bring-up evidence and the serving-loop unit suite, not
  yet by CI; the row un-skips with the terminal-state follow-up. A
  full stale-pointer roll-forward journey remains the named
  follow-up.
- M1's Phase-2 seam — per-run demanded identities: the demand
  carriage (watchedRootsForSpace per-instance entries + the
  SpaceServer's demanded-identity registry), the widened
  `ServerRunInfo` (`scopeKeyIdentity`/`actionScopeKey`) passed
  through `#stampRun`, and the tx-carried identity consulted at the
  traversal-context and result-cell sites. Cardinality 2 pinned at
  three levels (`executor-wave.test.ts`: the sink/engine same-doc
  two-instance fold and two stamped runs folding into one wave with
  per-run keys; `executor-serving-loop.test.ts`: the production-seam
  journey whose per-run outbox carriages carry two DIFFERENT keys
  into the completions — the m-4 note's "arrives with Phase 2's
  stamper" DISCHARGED). The per-run SUPPLY — the scheduler running a
  scoped action once per demanded instance (per-(action × instance)
  read-set/dirtiness state) and the replica-level per-instance read
  keying — is the owed scheduler-instance-dimension follow-up,
  reported to the plan as a proposed train cut (OW17 below).
- The ON-arm skip list: Phase 2 RETIRED the two-browsers entry (its
  named unskipping condition — the client derivation-commit path
  removed — is this PR; that gate now runs and passes ON) and ADDED
  one entry, `sx2-serving-loop`, under `phase-2-followup` — the
  demand-cycle starvation fork's reproducer (the owed row below
  carries the durable record; the skip reason carries the mechanism
  and the ruled id-class exclusion that reduced it).
- testing §4's single-deriver envelope gate: impl-covered — the
  store-attribution query pinned in `speculation-overlay.test.ts`
  (every derived commit's holder is the service identity; none from a
  client session).
- The standing rule's trigger has FIRED: Phase 2 flips ON, so the
  next full mapping pass is DUE — owed as a follow-up alongside the
  Phase-3 pre-flight, not carried in this PR.

**Phase 2 pre-gate — LANDED with Phase 2 (2026-08-07):**

- OW3 — LANDED as the model's narrowing/fan-out sub-model
  (`packages/spec-model/server-execution/model.ts`, C11a–C11c in
  `properties.test.ts`): instance sets stay clean products (never
  ragged, exhaustively), the fan-out unit is the RUN
  (`action × instance`, never merged), and W never forks — one
  integer whose ADVANCE waits on demanded siblings only (protocol
  §4's fresh-demand-after-W allowance modeled explicitly), undemanded
  instances never holding it back.
- OW4 — LANDED as trace T15 (scenario-traces §3/§4, count 14 → 15)
  plus impl witnesses, scoped precisely: input-origin RETIREMENT
  (acked AND W ≥ seq — the retire-after-coverage half) and
  never-serialized are pinned in `speculation-overlay.test.ts` /
  `sx2-speculation.test.ts`; unreplicated-doc-reads-pending and the
  KEEP half of §4 step 3 (an unacked origin holds the echo) are
  covered by T15's cited answers and speculation §2's normative text,
  with direct pins owed alongside the Phase-3 offline machinery
  (which builds the origin-queue fixtures they need).
- OW12 — LANDED: the discovered-narrowing eager via-user hop now has
  its direct test (`packages/runner/test/eager-via-user-hop.test.ts`,
  the OW12 case — a compiled pattern whose run READS a `PerSession`
  cell and discovers session narrowing at its result binding;
  space→user→session chain pinned, value at session).

Delta 2026-08-07 — the scheduler-tell classification batch (owner
ruling 2026-08-07; this PR):

- protocol §1's scheduler-tell rule (+1 rule, map edited with this
  delta; speculation §2 carries the cross-reference, counted once):
  → COVERED by the existing stamping-boundary pins — the ruling NAMES
  the landed boundary rather than changing it, and the boundary is
  already witnessed end to end in
  `packages/runner/test/speculation-overlay.test.ts` (stamped
  derivation-kind runs divert; handler runs commit authored — F10;
  UNSTAMPED setup/binding transactions commit as today; the
  store-attribution query — zero derived-class commits from any
  client session) and live in
  `packages/patterns/integration/sx2-speculation.test.ts`. The
  no-creation-carve-out corollary rides the same pins (a lift
  instantiation's run is stamped derivation-kind by construction);
  the imperative-creation `.pull`-for-round-one flow is exercised by
  the serving-loop demand path
  (`packages/runner/test/executor-serving-loop.test.ts`).
- speculation §4's retirement honesty sentence (+1 rule, map edited
  with this delta): → COVERED — the retirement trigger (watermark
  coverage of basis + acked origins, value arrival NOT awaited) is
  pinned in `speculation-overlay.test.ts`, and the safety machinery
  the sentence names — the demand-cycle ensure-retry on deferred
  structure loads — is pinned red-first in
  `packages/runner/test/executor-serving-loop.test.ts` (the
  demand-cycle ensure-retries test, c766ef453).

Delta 2026-08-07 — the Phase-2 INDEPENDENT review's fix batch (this
PR):

- A SECOND RECORDED OFF-arm acceptance rides Phase 2's R4 fix (RULED
  2026-08-07, owner — complexity-adjudicated: the whole-result
  validation's over-reach was latent on BOTH arms, and narrowing was
  chosen over carrying it; testing §2's gate clause already names
  this register's recorded-acceptance rows, so this row is the
  stage-G `tryClaimMutex` row's sibling). The delta:
  `PiecePropIo.set`'s non-stream branch moved from WHOLE-RESULT
  validation to WRITTEN-SUBTREE validation (`linkPathContracts`, the
  sibling stream branch's long-standing approach) — property writes
  that formerly threw on UNRELATED-property staleness (an absent or
  invalid sibling the write never touched — the ON arm's
  server-derived-late `$NAME` flake, and the same latent over-reach
  OFF) now succeed, while an invalid WRITTEN value still throws and
  correlated-anyOf paths keep the whole-result fallback (the one
  shape path contracts cannot decompose). Pinned in
  `packages/piece/test/pull-materialization.test.ts`: the ruled
  absent-unrelated-required and invalid-unrelated-sibling shapes
  (both RULED-2026-08-07-named tests), the explicit-undefined alias
  still surfaced by the write-destination validator, the
  derived-Cell-root pin reconciled to the narrowed contract, and the
  correlated-union path still validated.
- The settle input barrier's review pins (M2/M3/m4), landed with
  probe evidence: the own-echo VERDICT-RACE repair (a frame
  outrunning its verdict mis-records the echo as foreign; the
  settleAccept repair lifts it — deleting the repair turns the new
  `memory-v2-stacked-commit.test.ts` test red); the SpaceServer
  W-clamp's counter now matches serving-loop §7's binding sentence —
  it counts every wave whose advance the floor held below an
  otherwise-advancing batch head, FULL suppression and the
  remove-sentinel floor included (the pre-fix `advanceTo > W` guard
  missed exactly those; no spec change — the code moved to the
  sentence); and the clamp's min/max advance composition, the
  counter, and the PROMPT lift are pinned at the SpaceServer level
  (`executor-space-server.test.ts`, stubbed floor — either inverted
  Math.min/Math.max turns it red). The prompt lift is new mechanism
  (the review's m4): `ISpaceReplica.shadowFlipObserver`, installed at
  activation and fired by `confirmPending`'s flip, resolves the
  loop's input wait directly — without it a clamped-then-quiet space
  waited out IDLE_PARK_MS before the catch-up wave (probe: wake
  disabled, the prompt-lift pin times out red). The shadowed-REMOVE
  sentinel (floor 1) gained its replica-level pin, and the R2
  never-a-piece exclusion test now exercises the `cid:` class
  (dropping it from the exclusion turns the test red).
- `sx2-speculation`'s bounded destination-validator retry is now
  VISIBLE when it engages (a loud engagement log) and scoped to the
  cold-view creation window it exists for: the gate's new
  steady-state edit runs with ZERO retries, so the open
  set-validation fork engaging outside its window fails the gate
  instead of riding the mask (the review's m9).
- Provenance note for protocol §1's owner blockquote (the scheduler
  tell): its primary source is the owner's coordination-channel
  message of 2026-08-07 (off-GitHub), attested by the coordinator —
  the quote's fidelity is not independently verifiable from repo
  artifacts.

## 3. The owed register (every genuine orphan, with its trigger)

Nothing here blocks Phase 1. Each item names the instrument
extension owed and WHEN it earns its cost:

**Next model commit (cheap, do with the next ruling batch):**

- OW1 — forged `firedAt` admission negative: a client-supplied
  `firedAt` disagreeing with the envelope is REJECTED (events §1,
  scopes §5). One C6-style negative.
- OW2 — a lease renewal is NEVER a commit (serving-loop §2): renew
  transition asserts zero commit records.
- OW9 — the §3d rebase arm: the model's conflict machinery requeues
  EVERY raced consequence — it has no field-level-merge disposition —
  so the impl's three-way drop/rebase/requeue split (serving-loop
  §3d) is pinned by impl tests alone
  (`packages/runner/test/executor-wave.test.ts`). Owed: a model
  rebase-arm extension (commuting-patch merge plus the
  re-CAS-at-the-observed-head rule).

**Phase 2 pre-gate — LANDED with Phase 2 (2026-08-07; the delta
above carries the coverage):**

- OW3 — LANDED (the C11 narrowing/fan-out model family).
- OW4 — LANDED (trace T15 + the speculation impl witnesses).

**Stage F pre-gate — LANDED with stage F (2026-08-05):**

- OW5 — LANDED as trace T13 (scenario-traces §3/§4) plus the
  serving-loop tests: activation loads demand + queued events, never
  a piece-start step; auto-activation on authored admission /
  session open; parking honors pending gate wakes (N9's default,
  adopted). One residue stays owed, carried DELIBERATELY as T13.Q8's
  GAP: wish `#now` timers vs quiescence needs its own owner ruling
  first (N50) — see OW11 below.
- OW6 — LANDED: trace T13.Q5 + the end-to-end server-side hot-swap
  test (`executor-serving-loop.test.ts`): the pointer write is
  authored input, the SpaceServer swaps, the swapped derivation
  serves as a derived commit.
- OW10 — LANDED: `assertSchemaMemoIdentity`
  (`packages/runner/src/traverse.ts`) binds a shared memo to its
  first traversal's identity at the SchemaObjectTraverser choke
  point and throws on any other — the future-sharing change now
  trips loudly instead of silently value-bleeding.

**Still owed from the stage-F bucket:**

- OW11 — the N50 owner ruling (wish `#now` timers vs quiescence and
  the amplification budget), carried out of OW5: a space with an
  interval `#now` never quiesces and every tick is a derived
  commit; parking policy and the testing §4 gate need the ruling
  before builtins §1 ships `wish` as "port cost: none". T13.Q8
  holds the trace cell open.
- OW12 — LANDED with Phase 2 (2026-08-07): the discovered-narrowing
  fixture exists (`eager-via-user-hop.test.ts`'s OW12 case) and pins
  the `pattern-binding.ts` chain directly.
- OW13 — delegated-grant RESOLUTION (protocol §2's delegated row,
  carved out 2026-08-05): admission today validates carriage
  PRESENCE + COMPLETENESS (class, non-empty actor + grant, the
  sessionless session-scope refusal) and keys scoped writes from the
  carried identity; it does NOT resolve `capabilityRef` against the
  target doc/stream — today's ACL model holds no per-doc grants to
  resolve against. Owed: the grant-resolution check and its negative
  tests when a per-doc grant store lands. Trigger: the first
  producer of grant-scoped capabilities (protocol §2's anticipated
  grant-scoped checks) — no later than the outbox/provisioning
  producers going live (Phase 3 events; Phase 5 cross-space).

**Stage G pre-gate — LANDED with stage G (2026-08-06):**

- OW7 — LANDED as trace T14 (effect failure and retry: input-driven,
  never timers — scenario-traces §3/§4) plus the impl witness in
  `executor-serving-loop.test.ts` (the failure leg: an error-shaped
  result commits with the key, no timer retry fires, and only an
  input change re-fires).

**Phase 3 pre-gate (when events land; pulled by Phase 3's
pre-flight):**

- OW14 — the LT4 arm's source-side notice ORDER: when Phase 3 lands
  events.md §5's failure-notice machinery, the deterministic-
  rejection arm must write the events §5 notice BEFORE deleting the
  refused outbox row — today the delete discards
  `eventId`/`target`/`reason` except a warn log, and the obligation
  lives only in outbox.ts's LT4 comment. Owed: the write-then-delete
  ordering plus its test (a crash between the two must re-send and
  re-notice, deduped, never lose the notice). Trigger: Phase 3's
  events §5 machinery landing.
- OW15 — the sessionless space-scope floor carve-out's
  IMPLEMENTATION (SHAPE-RULED 2026-08-05, protocol §2): lift the
  source refusal in `enqueueOutboundAppend` for declared
  sessionless-space-scope entries, fix the delivery path's `?? ""`
  acting-principal mapping, land the floor negatives BOTH ways
  (userless space-scope-declared admitted with
  `firedAt = { session: "server" }`; userless without the
  declaration still refused) and the model pin. Trigger: Phase 3's
  event producers going live.
- OW16 — the llm-dialog tool mutations' RULED classifications
  (2026-08-05), implemented: pin and unpin commit as
  COMPLETION-CLASS turn-lifecycle state; updateArgument commits as
  a HANDLER-CLASS consequence. The three call sites carry the
  ruling in comments (llm-dialog.ts — awaited and surfaced since
  the stage-G review batch); the stamping/classing itself is
  Phase-3 events territory. Trigger: Phase 3's pre-flight.

**Phase 2 follow-up (APPROVED as its own follow-on stage — owner
nod, 2026-08-07; recorded in the plan's stage list):**

- OW17 — the scheduler instance dimension: per-(action × instance)
  read-set/dirtiness state, the N-run settle loop over demanded
  identities (consuming the SpaceServer's demanded-identity
  registry through the widened `#stampRun` seam), and the
  replica-level per-instance READ keying (one doc, N instances read
  locally — today's replica keys scoped docs by scope NAME, the
  cardinality-1 collapse the sink-level fold test documents). Until
  it lands, a scoped node's runs resolve via the wave-level identity
  (the Phase-1 fallback) unless a caller supplies per-run identities
  through the seam. Trigger: the approved follow-on stage (the plan's
  Phase 2 tail); no later than Phase 3's events (handler runs
  already carry per-run actors).
- OW19 — the demand-cycle terminal state (RULED direction,
  2026-08-07; the durable record for the starvation fork the
  `sx2-serving-loop` skip reproduces): the COMPLETE design is
  terminal-on-loaded-doc-without-pattern-meta with COMMIT-TRIGGERED
  re-arm — a loaded doc whose meta is absent stops retrying until a
  commit touches it — plus moving the demanded-structure load pass
  under the wave's flush deadline (today it runs before the settle
  race, unbounded, so a slow ensure throttles input consumption).
  The ruled id-class exclusion (computed:/cid:/watermark — landed
  with Phase 2, counter-exempt) removed the structurally-futile
  classes; the conflation hazard that makes the rest non-trivial:
  a not-yet-created piece and a never-a-piece `of:` value doc are
  indistinguishable by id, so a terminal state without the
  commit-triggered re-arm would break the creation race the
  ensure-retry fix exists for. Trigger: the Phase-2 follow-on PR
  (with OW17 or before it); the skip-list entry lifts with it.

- OW18 — the ensurer move (owner direction, 2026-08-07; recorded with
  the scheduler-tell batch, NOT implemented by it):
  `ensure-default-app-is-running` and pattern updating are
  outside-scheduler CLIENT acts today — authored under the scheduler
  tell, protocol §1 — and under the flag they can move server-side,
  triggered by a pull on a qualifying pattern (in the current setup:
  a system pattern from `/api/patterns`), after which flag-ON clients
  simply STOP calling those ensurers/updaters. Owed when it lands:
  the trigger's coverage (pull on a qualifying pattern ensures/
  updates server-side; flag-ON clients make no ensurer calls) beside
  the §3e watcher surface in `sx2-serving-loop`. Trigger: a Phase-2
  follow-on PR, no later than Phase 3.

**Phase 6 (the contract is fixed now, the check lands with
hardening):**

- OW8 — push priority: subscribed derived rows flush before
  bookkeeping/bulk (README §3.3, protocol §3). Counter/ordering
  assertion in `sx2-scale`.

Delta 2026-08-10 — the #5569 incremental-liveness catch-up (main
9d6c9fe00 cascaded through the train; one NEW binding sentence, two
re-homed pins from train-deleted test surfaces):

- serving-loop §8's liveness-bracket tripwire: NEW binding sentence
  (any future demand-root kind or root-flipping site MUST bracket its
  transitions with the liveness notifications; no global rebuild
  repairs silent flips — labs #5569). Coverage: the env-gated
  every-mutation equivalence hook in
  `packages/runner/src/scheduler/dependency-graph.ts`
  (`SCHEDULER_LIVENESS_EQUIVALENCE=1`, asserts incremental state
  equals `recomputeLiveRefs` at each mutator exit; run across the
  whole runner suite at catch-up: zero drift, and
  discrimination-verified by reinjecting the historical
  `unregisterDependentEdge` root-writer decrement skip), plus
  `test/scheduler/dependency-graph.test.ts`'s randomized
  every-mutation reference check. Silent-root-flip audit of the
  merged tree found every flip site bracketed
  (`updateSchedulerActionType`, `updateMaterializerRegistration`,
  `setNodeProvisionalDemand` callers; unsubscribe's envelope clear is
  post-unregistration and inert).
- per-doc-rehydration's resume-fresh reliance on scheduler-v2 §5.2's
  registration-recount order-independence: CROSS-REFERENCE recorded
  (a §5.2 recount change is a resume-correctness change). Coverage:
  same instruments as above; resume paths exercised under the
  equivalence hook by the runner suite's reload/resume tests.
- #5388's release-vs-stop pin ("releasing a target before link
  resolution preserves the held start") — its main-side home
  (`reload-rehydration-safety.test.ts`) was deleted with the
  observation machinery; RE-HOMED train-side as
  `packages/runner/test/release-vs-stop-link-resolution.test.ts`
  (green; discriminates — substituting stop for the release fails).
- #5529's verdict-precedes-fan-out — its main-side instrument gated
  `runPostCommitSchedulerSideEffects`, machinery the train deleted;
  RE-PINNED train-side in
  `packages/memory/test/v2-verdict-catchup.test.ts` ("the verdict
  leaves within the transact's publication turn; fan-out cannot
  enter it"), instrumenting the publication turn directly (green;
  discriminates — deferring the in-lock verdict publication fails
  it).

Delta 2026-08-11 — lunch-gate triage leg A: §3d's unstamped-seal
refusal caught real undeclared commit paths (this PR; serving-loop
§7's counter shape gains `unstampedSealRefusals` — a CHANGED
sentence, coverage below):

- §3d's "every server-side commit path declares its run context"
  (RULED 2026-08-05): the RULE was already covered (the Q4 refusal
  row); this delta records impl CONFORMANCE. A three-run
  instrumented triage proved the resumed list builtins'
  container-recovery seeds (`map`/`filter`/`flatMap` resume-seed +
  resume-settle — an out-of-band `editWithRetry` from a `.finally()`
  continuation, no scheduler run around it) sealed unstamped on the
  serving runtime: the wave refused, the seed retried into the
  refusal (97,341 throws in one 5-minute run), and the demanded map
  derivation never landed — breaking speculation.md §4's
  overlay-retirement premise (the serving loop's first-round
  reliability machinery makes the demanded derivation exist and
  land). Fixed by declaring the sanctioned internal `bookkeeping`
  kind at the runtime's posture-gated stamping seam
  (`stampServerRun` — a no-op on the OFF arm; under client
  speculation bookkeeping commits exactly as unstamped txs do), for
  the full audited class: the six list-builtin recovery writes, the
  shared list republisher, the compile-cache writebacks + pattern
  annotation (pattern-manager), the piece
  instantiate/start/repair/run-synced/pointer-roll-forward family
  (runner), the pattern updater's transition writes, wish's
  interval tick / error-UI / sidecar-run / ready writes, and the
  fetch / fetchProgram / llmDialog teardown claims-release txs.
  NOT stamped, per existing rulings: llm partial-stream writes
  (partials never become commits — the serving posture now SKIPS
  the write before minting a tx, the same ruled outcome the
  refusal produced, keeping the new counter clean),
  compile-and-run's async writebacks (stage-G deferral, documented
  in-file), and llm-dialog's pin/unpin/updateArgument/invoke
  tool-call writes (ruled completion-/handler-class — Phase-3
  territory). Coverage: impl-gate, red-first —
  `packages/runner/test/executor-serving-loop.test.ts` ("lands a
  resumed map derivation whose result container was never
  persisted") authors a map piece under client speculation (the
  production shape that leaves the result container unpersisted),
  resumes it through the demand loader, and pins BOTH the landed
  derivation and `unstampedSealRefusals === 0`; at the pre-fix
  tree the same test red-fails (counter at 3, the §3d refusal
  storm in the log).
- serving-loop §7's counter shape: `unstampedSealRefusals` added
  (CHANGED sentence — the refusal becomes a health-stats fact,
  structurally zero under conformance; any non-zero count names an
  undeclared commit path). Coverage rides the same impl-gate
  test's `=== 0` assertion.

This closes leg A of the lunch-gate triage arc (the unstamped
recovery-seed storm). Leg B — the OW19 demand spin
(`structureLoadDeferred` climbing) — is separately owned; leg C
(the speculative-pending-basis design fix) is closed by the
2026-08-13 delta below.

Delta 2026-08-13 — lunch-gate triage leg C: the speculative-basis
export refusal (RULED 2026-08-13; speculation.md §6's "process-local
principle and the export refusal" carries the rule and the owner
blockquote; this PR):

- speculation.md §6's "a commit basis MUST NOT name a speculative
  layer" (the export refusal): → COVERED, impl-gate, red-first.
  `packages/runner/test/speculation-overlay.test.ts` ("an authored tx
  that read a speculative echo is refused LOUDLY at the client")
  drives a real client-flag-ON runtime to a live echo, commits an
  unstamped tx that read it, and pins the terminal client-side
  `SpeculativeBasisError` (isTerminalRejection true), the unchanged
  engine commit count (nothing exported), the intact overlay entry,
  and the never-rendered refused write. At the pre-fix tree the same
  scenario exported the seq and red-failed with the server's
  `ConflictError: pending dependency not resolved: 4` after a wire
  round trip.
- The bounded-and-loud convergence half (the ruling's "fix infinitely
  stuck things"): → COVERED, red-first. The same file's "a handler
  that read a speculative echo fails terminal on the FIRST attempt"
  pins exactly ONE handler run per event (console-channel counting —
  the sandbox globalThis is isolated); pre-fix the backoff loop
  re-ran the handler throughout the observation window (17 runs / 5s
  observed; production shape ~43 attempts / 30.5s to
  CommitConvergenceError). The push-boundary belt (a ConflictError
  naming a known-speculative layer upgrades to the terminal refusal)
  is unreachable-by-construction behind the build-time refusal and
  carries no separate pin — `speculative-basis-exported` in the log
  names any future reach.
- The origin-ack retirement wake (speculation.md §6's closing
  paragraph; the verdict-lifetime sub-defect): → COVERED, impl-gate,
  red-first. The same file's "an entry whose origin's accept verdict
  lands AFTER the covering watermark still retires" scripts the race
  destination-level (watermark event first, ack after; no further
  watermark event) and pins retirement on the ack wake alone;
  pre-fix the entry stayed pending forever (red: the observer was
  never installed and the sweep never re-ran).

## 4. Standing rule

A ruling batch that adds a BINDING sentence adds its coverage row
(or its owed entry) in the same PR — this register is under the same
docs-move-together rule as everything else. The next full mapping
pass is due when the owed register empties or Phase 2 flips ON,
whichever comes first.
