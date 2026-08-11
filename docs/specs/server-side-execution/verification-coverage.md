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

295 binding rules. Instruments: the scenario traces (T1–T12), the
field-provenance chains, the executable model (C1–C10 property
families), the Phase 1 dry-run, and the doc-review panels
(weak — counted only where nothing else applies).

| doc | rules | instrument-covered | impl-gate | deferral | derivable | owed |
| --- | --- | --- | --- | --- | --- | --- |
| README | 31 | 17 | 9 | 1 | 2 | 2* |
| protocol | 58 | 44 | 6 | 3 | 4 | 1* |
| events | 34 | 25 | 4 | 2 | 2 | 1 |
| scopes | 25 | 17 | 3 | 1 | 2 | 2 |
| builtins | 15 | 6 | 3 | 1 | 4 | 1 |
| serving-loop | 77 | 45 | 20 | 1 | 5 | 6 |
| key-vocabulary | 9 | 5 | 3 | 0 | 0 | 1 |
| speculation | 15 | 10 | 2 | 0 | 1 | 2 |
| testing | 14 | 4 | 10 | 0 | 0 | 0 |
| runtime-mapping | 17 | 5 | 3 | 1 | 5 | 3 |

(*push-priority appears in two docs — counted once in §3.)

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

**Phase 2 pre-gate (when fan-out/speculation semantics go live —
extend the model with narrowing, and the traces with a client-side
journey):**

- OW3 — instance sets never RAGGED across principals (scopes §2);
  CFC unit `action × instance` under fan-out (serving-loop §3c);
  no per-instance watermark forks (scopes §9). One narrowing/fan-out
  model extension covers all three.
- OW4 — speculation client-side trio: unreplicated-doc reads go
  pending; input-origin overlay retirement (ack + W ≥ seq); overlay
  never serialized to any server (speculation §2/§4/§6).

**Stage F pre-gate (SpaceServer behaviors — one activation-journey
trace, T13 candidate):**

- OW5 — activation loads demand + queued events, never a
  piece-start step (serving-loop §1; runtime-mapping N22/N31);
  event-to-parked-space auto-activation; parking vs pending
  gate-wakes (N9); wish `#now` timers vs quiescence (N50 — carries
  its own owner ruling first).
- OW6 — pattern-pointer hot-swap runs server-side (serving-loop
  §3e; N40/41).
- OW10 — the schema-memo single-identity guard (key-vocabulary §5):
  an explicit tripwire or assertion that no memo instance is shared
  across identities, landed BEFORE any cross-run memo sharing.
  Today every sharing scope is single-identity by construction;
  the guard is what keeps a future sharing change from silently
  becoming value-bleed.

**Stage G pre-gate:**

- OW7 — effect failure retries are input-driven, never
  timer-driven (serving-loop §4); one failure-path trace question.

**Phase 6 (the contract is fixed now, the check lands with
hardening):**

- OW8 — push priority: subscribed derived rows flush before
  bookkeeping/bulk (README §3.3, protocol §3). Counter/ordering
  assertion in `sx2-scale`.

## 4. Standing rule

A ruling batch that adds a BINDING sentence adds its coverage row
(or its owed entry) in the same PR — this register is under the same
docs-move-together rule as everything else. The next full mapping
pass is due when the owed register empties or Phase 2 flips ON,
whichever comes first.
