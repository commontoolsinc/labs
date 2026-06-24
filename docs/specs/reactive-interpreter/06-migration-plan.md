# Phased plan, oracle, formal track, and risks

The interpreter becomes the default execution model, staged. This document gives
the phase order, the differential oracle that de-risks the cutover, the formal
proof track, the data-migration story, and the risk register.

---

## 1. Phasing principle

Each phase is independently shippable and measured against the baseline harness
([05](./05-baselines.md)). The dominant cost is collection per-element fan-out,
so the first real win targets exactly that, behind the differential oracle, then
generalizes outward. "Default model, staged" means we build toward full
replacement but never run two divergent models in production — the oracle
compares them; production runs one.

## 2. Phases

### Phase 0 — Substrate & instrument (no behavior change)

- **P0.1** Land the baseline harness as a measured CI artifact; extend it to emit
  the before/after table and the three spectrum fixtures
  ([05](./05-baselines.md) §6).
- **P0.2** Define the ROG type and the trusted extraction `Pattern → ROG`
  (normalization only; not yet executed). Validate it round-trips the existing
  corpus.
- **P0.3** Confirm scheduler-v2 landed semantics for the materializer envelope,
  P1/P2/P4, and `invalidCauses` against code (the inventory flags drift; this is
  the re-verification step the synthesis required).
- **P0.4 (prerequisite machinery, [04](./04-scheduler-and-transformer-deltas.md)
  §0).** Build the **§8.9.1 trust gate** (`isTrustedForConcept`,
  `flow-taint-precision`, concept-trust delegation, `deriveLabelWithTrustGate`)
  generalized to path-granular `LabelView`s — it does not exist today and Phase 2
  depends on it. Build the **read-isolation capability** (P-0.3), the chosen
  **interior non-convergence API** (`tx.markSelfInvalid()` / `fn` not-done signal,
  Delta E) and the **idempotency recheck hook** (Delta C1). These are not
  interpreter code per se but hard prerequisites
  for its CFC soundness and correctness.

Exit: ROG extraction exists and round-trips; harness measures both models; the
scheduler seam is confirmed; the trust gate + read-isolation + recheck/convergence
hooks exist.

### Phase 1 — Interpret a single leaf/access/construct ROG (no collections)

- **P1.1** Implement `InterpreterState`, `evalFull`, `evalIncremental` for
  `leaf` / `access` / `construct` / `control` (no `collection` yet). Leaves call
  the existing harness.
- **P1.2** Implement the materialization boundary (reachable-from-**egress**) and
  the top-outputs write surface (Delta A) for these kinds.
- **P1.3** Implement per-op label computation with the **flow join** (conf union +
  integrity meet, not view-union — [03](./03-cfc.md) §4) and the fail-closed
  conservative fallback; route egress through existing ceilings.
- **P1.4** Wire the idempotency recheck hook against a **state clone + pre-run
  snapshot** (Delta C1), and stand up the differential oracle (§4) as the gate.

Exit: a non-collection pattern runs on the interpreter with **identical outputs
and labels** to the materialized model (oracle, §4), at `O(1)` interior docs.
This already removes the per-op scaffolding for fine-grained patterns.

### Phase 2 — Collections (the main win)

- **P2.1** Implement `evalCollection` with in-interpreter per-element recursion,
  identity keying (reuse `cellIdentityKey` semantics), inline-array `Construct`
  result, and orphan release (R-MAT-5).
- **P2.2** Implement the operator-split label rules (`map` pointwise;
  `filter`/`flatMap` element-local + structure taint, [03](./03-cfc.md) §5.3),
  **enforced read isolation** (R-CFC-ISO, the load-bearing soundness obligation),
  and the trust-gated claim — co-developed with the formal pseudocode (§6) and the
  differential CFC corpus (§4). Write per-index labels as stored metadata
  components with origin, not a component-blind view.
- **P2.3** Preserve `O(1)` edit; implement path-granular container rewrite
  (T-EDIT). Add **scope carry-through** to each output's effective scope (R-SCOPE):
  track narrowest scope read; stamp the output link's scope; verify a scoped `map`
  serves per-reader instances correctly.
- **P2.4** Measure against `map` N=5/50/500/5000: confirm `O(1)` docs/nodes,
  `O(1)` edit, sub-linear load; confirm the read-index stays `O(distinct external
  reads)` and quantify its cost.

Exit: `map`/`filter`/`flatMap` run on the interpreter; the `~5 + 3N` / `~8 + 4N`
document/node laws are replaced by constants (non-scoped); the oracle shows value
parity and label over-approximation (incl. the integrity direction and the
isolated-read lower bound). **This is the phase that pays for the project.**

### Phase 3 — Checkpoint / memoization tier

- **P3.1** Implement checkpoint write/read, the automatic cost/size policy, and
  the author override marker (R-MAT-4).
- **P3.2** Implement derivation-tracked staleness via scheduler state (Delta D1)
  and resume-from-checkpoint (R-PERSIST-2).
- **P3.3** Measure the importer simulation (M = 1k/10k): confirm resume is
  `O(checkpointed + demanded)`, not `O(M)`.

Exit: a large pipeline survives restart without from-scratch recompute; the
durable footprint is interface + checkpoints.

### Phase 4 — Nested patterns & lazy external addressability

- **P4.1** `pattern` recursion in-interpreter; outermost-owns-persistence
  (R-MAT-2).
- **P4.2** Lazy promotion of internally-referenced cells to reproducible-id
  external documents (R-MAT-3); cross-pattern links and FUSE parity.

Exit: patterns-calling-patterns run fully interpreted; cross-pattern links into
(now lazily-materialized) internals work.

### Phase 5 — Default-on & retire materialization

- **P5.1** Flip the interpreter to default for all patterns; keep the legacy
  materialized path available only as the oracle reference.
- **P5.2** Retire per-node materialization for derived state; delete the dead
  `map`/`filter`/`flatMap` child-pattern-instantiation path.
- **P5.3** Migrate persistence: interpreter observations + checkpoints replace
  per-internal-cell observations.

Exit: one execution model in production; the per-element child-pattern
materialization machinery (the `~5 + 3N` document cost) is deleted.

## 3. Data migration

Nearly free, by the structure of what is materialized
([01](./01-requirements.md) R-MAT-1, user directive):

- **User state already materializes.** Writables and changed pattern arguments —
  the only genuinely durable user state — materialize as documents in the new
  model exactly as they do today. Existing such documents are reused as-is.
- **Everything else is derived.** Internal/derived cells are recomputable from the
  ROG + inputs, so they need no migration; they simply stop being materialized on
  re-instantiation. Internal cell ids are *not* preserved (NG5).
- **External references.** Cross-pattern links that point at what is still
  externally reachable continue to resolve; links that pointed at a now-internal
  derived cell resolve via causal carry-through ids (R-MAT-3), or are recomputed.
  No bulk in-place rewrite of internal-cell documents is required.
- **Net:** preserve user-state documents; let derived state rebuild. This matches
  the prior identity-migration precedent (data-wipe-of-derived was acceptable
  there too).

## 4. The differential oracle — the permanent correctness gate

Because the inline idempotency validator structurally cannot witness interpreter
incrementalism bugs ([04](./04-scheduler-and-transformer-deltas.md) §4), the
differential oracle is **not** a migration aid that retires at cutover — it is the
**permanent, hard correctness gate** for interpreter correctness. The legacy
materialized model is retained (even after Phase 5 default-on) as the oracle
reference for as long as the interpreter ships.

- **O1 — output diff (hard gate).** For a corpus of patterns + inputs, assert the
  interpreter's materialized outputs equal the legacy model's value on every
  external cell.
- **O2 — label diff (hard gate), both axes.** Assert, per path: interpreter
  **confidentiality ⊇** the legacy per-element-transaction confidentiality, and
  interpreter **integrity ⊆** the legacy integrity (the meet direction, BL-3) —
  with **zero** unauthorized narrowing — **and** that every element label is **≥**
  that element's *isolated-read* flow join (the read-isolation lower bound,
  R-CFC-ISO). This is the empirical guard that catches a precision or
  read-isolation bug before it ships.
- **O3 — wired into `cf test`.** Runs on the existing corpus and the multi-user
  runners, plus the §6 spectrum fixtures.

Per the chosen assurance level, the oracle is the practical gate; there is **no
commit-digest to bind into** ([03](./03-cfc.md) §6). The formal track (§6) is the
rigorous complement and the source of truth the pseudocode and oracle are
validated against — it does not replace the oracle as the CI gate.

## 5. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| **Interpreter becomes a CFC hole** (unsound pointwise claim / read-isolation bug). | Build the §8.9.1 trust gate (prerequisite P-0.1); **enforce** read isolation (R-CFC-ISO); the O2 label-diff oracle (both axes + isolated-read lower bound) as the permanent gate; the formal read-isolation + refinement obligations (§6). Fail closed by default. **Note this is a net increase in trusted-claim surface, accepted for the footprint win** (G3). |
| **Reintroducing the P1 second channel.** | The interior index is ephemeral one-node state, driven only by the scheduler's change delivery (NG4, [02](./02-design.md) §5); the index reuses exact `trigger-index.ts` semantics (Delta B2) but is genuinely new trusted machinery, reviewed explicitly against v2 §14. |
| **Interior non-convergence silently commits a wrong value** (self-suppression hides it). | A scheduler-v2 self-invalidate API (`tx.markSelfInvalid()` / `fn` not-done) surfaces non-convergence as the ordinary "node still invalid" condition, so pass-level iteration cap + backoff + `non-settling` telemetry apply (Delta E); never a partial self-suppressed commit. |
| **Lost cross-pattern links / FUSE.** | Position-anchored *deterministic* ids (identity never lazy, only materialization — R-MAT-3); Phase 4 explicitly validates link + FUSE parity. |
| **Checkpoint staleness bugs cache wrong values.** | Checkpoint `derivedFrom` is the **transitive external-read closure** (MA-6), invalidated by scheduler state; checkpoints never change semantics; the oracle compares checkpointed vs from-scratch; GC on element removal (MN-8). |
| **Scoped (PerUser/PerSession) data.** | Interior is per-running-scope (non-serialized); the requirement is dynamic scope carry-through to each output's effective scope (R-SCOPE). Container + scope-invariant work get the win; only genuinely scope-varying outputs exist per observed scope (intrinsic to scoping). |
| **Read-index stays O(N)** for per-element external reads. | Accepted and scoped: G1/I2 are document/node claims; read-index rows are far cheaper than documents (no value/conflict/revision); quantified in [05](./05-baselines.md). |
| **Scheduler-v2 not fully landed / drifted.** | P0.3 re-verifies the seam against landed code before building on README claims. |
| **Idempotency recheck can't witness incrementalism bugs.** | Recheck hook runs `evalFull` against a state clone + pre-run snapshot (Delta C1); the differential oracle is the **permanent** gate (§4). |
| **Debug/introspection regresses** (internal cells no longer inspectable). | Accepted; debug is to be rethought (user directive). Interpreter exposes an interior snapshot/trace API as the replacement, designed later — not a blocker. |

## 6. Formal proof track — new model work (not "one step away")

The earlier draft's "one step from proof / reduces through the existing
`ReactiveOperationGraph` bridge" is **retracted**: that Lean type is an
audience-delivery namesake, and `PointwiseFlow.lean` / `Collection.lean` are
label-free value models ([03](./03-cfc.md) §8). The interpreter's soundness is
**new model work**. In lockstep with Phase 2 (refined through Phase 5), the CFC
spec at `~/src/specs/cfc` gains:

1. **Spec text + pseudocode.** A new runtime implementation profile (a §18
   profile, sibling to §18.6 "Default-Transition Propagation Profile (Reactive
   Runtimes)"), **theorem-connected** per the Full-Proof Contract clause 4 (not
   regression-only prose), plus an extension to §8.9.1 framing the interpreter as a
   trusted flow-precision claimant. Normative pseudocode for `evalIncremental`,
   `labelOf` (with the integrity-meet), the operator-split collection rules,
   read-isolated `evalElement`, the trust gate on a `LabelView`, trigger-read
   scoping, and the materialization boundary — each block mapped to one Lean
   definition or explicitly marked illustrative.

2. **The ~10 new proof obligations** ([03](./03-cfc.md) §8), none of which exist
   today; ~6 are new model surfaces:
   - (1) interpreter operational model over a real ROG datatype;
   - (2) labeled decomposed reference semantics (the missing LHS comparator —
     `PointwiseFlow`/`Collection` are value-only);
   - (3) **read-isolation lemma** (element eval factors through `(i, xs[i])`) —
     the hard soundness gate;
   - (4) refinement: interpreter label view ≥ obligation-2's decomposed view;
   - (5) incremental == full (value-gated prune + trigger-label join +
     read-delta);
   - (6) trust-gate composition lifted from single `Label` to `LabelView`;
   - (7) integrity-meet (not union) lemma;
   - (8) materialization soundness (static surface over-approximates dynamic
     reachable set);
   - (9) trigger-read scoping soundness;
   - (10) §18 profile theorem-connection.

3. **Correspondence audit.** Audit that the pseudocode matches the implementation
   and that the proved property matches the security goal (pointwise
   non-interference of element flows, with read isolation as the structural
   premise). The empirical complement is the permanent differential oracle (§4).

This CFC-spec change lands as a companion PR in the `~/src/specs/cfc` repo and is
tracked alongside the implementation phases. It is the rigorous source of truth,
not the CI gate.
