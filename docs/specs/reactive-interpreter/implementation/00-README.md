# Reactive Interpreter — Implementation Work Orders

> **Audience**: the implementing agent(s). This directory is the **single source
> of truth for implementation progress** — status lives in
> [`PROGRESS.md`](./PROGRESS.md), decisions in [`DECISIONS.md`](./DECISIONS.md),
> not in any agent's private memory or chat scrollback.
> **Reviewer**: each work order is reviewed against its exit checklist before its
> PR merges.

## Required reading (before any code)

1. [`../README.md`](../README.md) — the design overview, goals (G1–G5), non-goals.
2. [`../01-requirements.md`](../01-requirements.md) — the R-* requirements, the
   invariants (I1–I8), and the open questions (§9). **OQ-4 is the one
   load-bearing open question** (CFC per-path labels).
3. [`../02-design.md`](../02-design.md) — the ROG + interpreter architecture.
4. [`../03-cfc.md`](../03-cfc.md) — the CFC trust model.
5. [`../04-scheduler-and-transformer-deltas.md`](../04-scheduler-and-transformer-deltas.md)
   — prerequisites (§0) + scheduler-v2 / transformer deltas.
6. [`../05-baselines.md`](../05-baselines.md) — measured baselines + the two
   spike results (the win + the CFC smear). The spikes are the measurement
   instruments this work graduates into permanent benches/oracles.
7. [`../06-migration-plan.md`](../06-migration-plan.md) — phase rationale + risks.

## What the spikes already proved (so we don't re-litigate)

- **The win is real** (`packages/runner/test/spike-map-interpreted.test.ts`):
  collapsing map-of-leaf into one coordinator drops documents from `~3N` per
  element to `O(1)` (1505 → 5 at N=500), computation nodes `N → 1`, ~11× load,
  edit stays `O(1)`. The inline-container edit is a path-scoped patch (the
  whole-rewrite falsifier does not bite).
- **CFC: a naive single-tx interpreter SMEARS** (`spike-cfc-oracle.test.ts`):
  every output gets the join of all elements' labels. Smearing is the *sound*
  (over-tainting) direction, but it is a precision regression vs legacy's
  pointwise labels. Pointwise content labels require a new trusted per-path
  label-emit — **this is OQ-4** ([DECISIONS](./DECISIONS.md) D-OQ4).

## Work-order sequence

Dependency-ordered. Detailed per-order docs (`NN-*.md`) are written when each
order begins; until then this table + the cited spec sections are the order.

> **AS-BUILT NOTE — canonical status lives in [PROGRESS.md](./PROGRESS.md) +
> [DECISIONS.md](./DECISIONS.md).** This table is the *original* dependency plan;
> the implementation diverged. **D-SEQ (OQ-4 precision first) was superseded by
> D-W3-PRECISION = Option A:** collections land pointwise via per-element
> *documents* (the W3 mechanism), so the separate W2 "per-path content-label
> emit" was NOT needed and is deferred as Option B (only for an O(1)-footprint
> variant). The actual landed sequence: W0 → W1 evaluator → **W2 *finding*
> (D-OQ4-FINDING, not the per-path mechanism)** → W3 collection prototype →
> **production wiring behind the default-off flag (D-PROD-PATH)** →
> control-semantics fix → `map`-into-dispatch → error-isolation → W5a nested
> inlining → effect-classification fix → merge-readiness review. The Status
> column is updated to match; the "Contents" cells still describe original intent.

| # | Work order | Contents | Depends on | Status (as-built) |
| --- | --- | --- | --- | --- |
| W0 | Substrate & instrument | Graduate the two spike harnesses into CI benches + the differential oracle; define the ROG type + a trusted `Pattern → ROG` extraction that round-trips the corpus; **re-verify the scheduler-v2 seam against landed code**. | — | ✅ done (harness + baseline + ROG type + extraction + seam D-SEAM) |
| W1 | Interpret leaf/access/construct/control | `InterpreterState`, `evalFull`/`evalIncremental` for non-collection ops; egress-based materialization boundary (R-MAT-1); flow-join labels (confidentiality union + integrity **meet**, not view union — coarse is *correct* here: a single computation legitimately depends on all its inputs); idempotency-recheck hook (Delta C1) + interior-non-convergence API (Delta E). | W0 | ✅ landed (evalRog + extraction + per-op error isolation; correct on the real path under the flag) |
| W2 | **OQ-4 — per-path content-label emit (precision mechanism)** | The trusted mechanism for a single batched node to emit per-path `derived` content labels computed from **read-isolated** per-element evaluation. | W1 | ⛔ NOT built — **superseded.** The *finding* (D-OQ4-FINDING) showed pointwise needs per-element docs; collections took that route (W3/Option A). The per-path emit is **deferred = Option B** (only for an O(1) container). |
| W3 | **Collections — the win (pointwise)** | `evalCollection` (per-element docs, no child patterns), pointwise per-element labels, scope carry-through. Measure footprint vs legacy; CFC parity. | W2 | ✅ `map` landed + wired into the dispatch (footprint 1 doc/el vs legacy 3, pointwise CFC). filter/flatMap fall back (need container-structure taint). |
| PROD | **Production wiring (D-PROD-PATH, not in original plan)** | Flagged dispatch into `instantiatePattern` with legacy fallback; pure fail-closed eligibility probe; census instrumentation. | W1 | ✅ landed, default-OFF. The shortest path to running the real suite against the interpreter. |
| W4 | Checkpoint tier | Checkpoint write/read; cost/size policy; derivation-tracked staleness; resume. | W3 | ⬜ not started |
| W5 | Nested patterns + addressability | `pattern` recursion in-interpreter (outermost owns persistence); causal carry-through ids; cross-pattern links + FUSE parity. | W3 | 🟡 **W5a landed** (top-level pure-computation inline — 0 child docs). **W5b** (addressability / retained deep links / FUSE) ⬜ not started. |
| W6 | Default-on & retire materialization | Flip the interpreter to default; delete the child-pattern instantiation path; migrate persistence. | W4, W5 | ⬜ not started (the flag stays default-off; this is the eventual cutover). |

**Note (as-built):** W2 (OQ-4 per-path emit) is NOT the long pole that landed —
it was sidestepped by Option A (per-element docs). The remaining big features are
filter/flatMap (CFC container-structure taint), handler/effect support
(per-effect scheduling), and W5b addressability. See PROGRESS for the ranked
backlog.

## Global rules (mirroring the scheduler-v2 work-order discipline)

- **G1 — small commits.** One coherent step = one commit; never squash unrelated
  steps. End commit messages with the repo's `Co-Authored-By` trailer.
- **G2 — worktree pre-commit gotcha.** The pre-commit hook inspects the default
  worktree, not this one; new files fail spuriously. After local verification,
  commit with `--no-verify`. Never `--amend` (blocked).
- **G3 — branches stacked onto the umbrella PR #4298 (D-PR).** Each work order is
  its own stacked branch off the previous; they roll up into #4298, which merges
  once as a coherent unit. Don't wait for review between orders; review is async,
  per-branch. Each branch updates `PROGRESS.md`.
- **G4 — red-green TDD.** A failing test first (the spec behavior or the bug),
  confirm red, then green; show the transition in the PR.
- **G5 — measured, not asserted.** Every footprint/perf/precision claim is backed
  by the W0 bench or the differential oracle, not prose.
- **G6 — the differential oracle is the permanent correctness gate.** Run the
  interpreter and the legacy materialized model on the corpus; assert identical
  outputs and label over-approximation (conf ⊇, integrity ⊆, isolated-read lower
  bound). Keep legacy as the oracle reference until well after default-on.
- **G7 — stop and report on divergence.** If reality disagrees with the spec (a
  scheduler invariant has drifted, an API isn't as described), STOP that step and
  record it in [DECISIONS](./DECISIONS.md) — don't improvise or widen scope.

## Exit checklist (per work order)

Each order's PR must, before merge:
1. pass G4 (red→green) with the new tests named in the order;
2. update [`PROGRESS.md`](./PROGRESS.md) (status + the measured numbers / oracle
   result);
3. record any new decision or divergence in [`DECISIONS.md`](./DECISIONS.md);
4. pass an adversarial review (the `cf-review` skill or a review workflow)
   against this checklist and the cited invariants (I1–I8).

## How to update tracking

- Flip a row's **Status** in the table above *and* the matching entry in
  `PROGRESS.md` as work lands.
- Append decisions/divergences to `DECISIONS.md` with a date and the evidence.
- Keep this in the PR — do not track progress in agent memory or chat.
