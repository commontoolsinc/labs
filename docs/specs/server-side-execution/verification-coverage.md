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

281 binding rules. Instruments: the scenario traces (T1–T12), the
field-provenance chains, the executable model (C1–C10 property
families), the Phase 1 dry-run, and the doc-review panels
(weak — counted only where nothing else applies).

| doc | rules | instrument-covered | impl-gate | deferral | derivable | owed |
| --- | --- | --- | --- | --- | --- | --- |
| README | 31 | 17 | 9 | 1 | 2 | 2* |
| protocol | 53 | 43 | 3 | 2 | 4 | 1* |
| events | 34 | 25 | 4 | 2 | 2 | 1 |
| scopes | 25 | 17 | 3 | 1 | 2 | 2 |
| builtins | 15 | 6 | 3 | 1 | 4 | 1 |
| serving-loop | 71 | 43 | 17 | 1 | 4 | 6 |
| key-vocabulary | 6 | 5 | 1 | 0 | 0 | 0 |
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

## 3. The owed register (every genuine orphan, with its trigger)

Nothing here blocks Phase 1. Each item names the instrument
extension owed and WHEN it earns its cost:

**Next model commit (cheap, do with the next ruling batch):**

- OW1 — forged `firedAt` admission negative: a client-supplied
  `firedAt` disagreeing with the envelope is REJECTED (events §1,
  scopes §5). One C6-style negative.
- OW2 — a lease renewal is NEVER a commit (serving-loop §2): renew
  transition asserts zero commit records.

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
