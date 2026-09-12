# Lazy materialization fast-follow

Status: F0 complete; F1 in progress. This plan is the separate follow-up to the
[pattern computation cost](../history/plans/pattern-computation-cost.md) work,
whose [implementation record](../history/plans/pattern-computation-cost-implementation.md)
transferred its D1/D2 measurements here. It owns the remaining handler
investigation, default-on rollout evidence, flag retirement, and those
measurements. It does not authorize a live lunch-poll update.

The [lazy materialization design](lazy-cell-materialization.md) defines the
schema-observing view and snapshot contracts. Lift arguments use that view under
the default-on `lazyMaterialization` flag. The handler path in
[`runner.ts`](../../packages/runner/src/runner.ts) still reads its argument
without marking the transaction for lazy materialization. Its closed-world event
validation, cold-input handling, receipts, and effects make it a separate
integration problem.

## Scope and decision

Complete the outstanding work in this plan after the computation-cost arc,
with independent PRs and acceptance evidence. Keep handler semantics separate from removing the lift-path
rollout switch: either can expose a correctness issue the other does not
address. The flag's owner and removal condition remain recorded in
[Experimental options](../development/EXPERIMENTAL_OPTIONS.md#lazymaterialization).

The alternative was to expand the computation-cost arc into handler behavior
and rollout changes. Keeping a separate plan lets its measured collection
improvements close with their own evidence and gives the broader behavioral
changes an explicit review boundary. Deferring the work without an execution sequence would leave the
default-on flag and handler exception without a completion path.

## Execution tracker

Mark a step complete only with its linked evidence. Capture decisions and
completed investigations in `docs/history/`; update the live contract documents
in the same PR as behavior changes.

| Step | Depends on       | Deliverable                                                           | State   |
| ---- | ---------------- | --------------------------------------------------------------------- | ------- |
| F0   | Computation-cost acceptance | Fixed baseline and remaining-call-site inventory | Done: [F0 baseline](../history/development/performance/2026-09-11-lazy-materialization-f0-baseline.md) |
| F1   | F0               | Handler materialization contract and measured prototype               | In progress |
| F2   | F1               | Reviewed handler integration, or an explicit evidence-backed deferral | Pending |
| F3   | F0               | Default-on rollout evidence and flag-retirement decision              | Pending |
| F4   | F3               | Remove the lift rollout switch and redundant fallback dispatch        | Pending |
| F5   | F2, F4           | Repeat measurement matrix, update guidance, and archive plans         | Pending |

F1/F2 and F3 can proceed independently. F4 does not depend on making handlers
lazy unless F1 identifies a concrete shared contract that requires that order.
Do not delete eager materialization that unmarked transactions still require.

### F0 — Establish the baseline

- [x] Inventory flag consumers, lift and handler argument entry points, and
      eager reads required for result writing, diffing, or unmarked callers.
- [x] Pin a runtime revision and record flag posture for each process. Preserve
      the controlled 74-, 296-, and 1,184-vote fixtures and the representative
      copy's current-day filter and linked-profile limitations.
- [x] Record completed-attempt reads, reactive-body reads, handler and commit
      work, graph size, allocation/retention, and disabled-accounting durations
      in separate windows. Preserve their different accounting boundaries.

The [F0 baseline](../history/development/performance/2026-09-11-lazy-materialization-f0-baseline.md)
holds the inventory, the posture table, and the per-phase handler dispatch
measurement from `packages/runner/test/handler-dispatch-cost.bench.ts`. Its
retention probe was inconclusive and is recorded as such; the representative
copy was not re-run and its limitations carry forward. Two of its findings
shape F1: the dependency preflight, not the argument read, dominates a
handler dispatch, and a handler's read log is its commit precondition set,
which a view would narrow.

### F1/F2 — Decide and integrate handler materialization

- [ ] Specify which bound context paths can be lazy and which event-payload
      checks must complete before the body runs. Start from the existing
      `$event` / `$ctx` split and closed-world event gate; do not weaken payload
      validation as a side effect of narrower context reads.
- [ ] Define touched required-field refusal, optional mismatch, missing linked
      data, and caught refusal. Distinguish cold input withdrawal from permanent
      invalidity; do not consume an event that never ran or commit partial
      handler writes as a successful handling.
- [ ] Pin receipt identity, duplicate delivery, retry, and effect behavior in
      both client and server execution. Test that a refusal after a write does
      not publish that write or an external effect.
- [ ] Test read/write snapshots, defaults and absent-path dependencies,
      cross-space context, labels read before and after policy preparation,
      escaped views, and asynchronous handler continuations where supported.
- [ ] Compare a scalar read from a large bound context with a full walk and with
      mutation-heavy handlers. Measure argument setup separately from the body
      and commit preparation so work is not merely moved out of a counter.
- [ ] Review the proposed contract and measured prototype. Implement the lazy
      context path if it preserves the event contract with a useful measured
      consequence; otherwise record the specific blocker, alternatives, and
      condition for revisiting it. A deferral must be explicit, not an unchecked
      handler exception hidden in a completed lift rollout.

Use the existing transaction mark, schema-refusal state, snapshot view and
event-finalization paths. Keep the mark's lifetime bounded to the argument/body
contract; result serialization, policy preparation and scheduler bookkeeping
must not accidentally inherit it.

### F3/F4 — Retire the lift rollout switch

- [ ] Assemble default-on evidence with exact revisions, environments, covered
      workloads, observed failures, and any use of the rollback override. State
      the observation period; elapsed time alone is not acceptance.
- [ ] Run the relevant equivalence, refusal, snapshot and dependency tests in
      both current flag postures. Resolve unexplained differences and check
      production-like client/server behavior on isolated data.
- [ ] Obtain the flag owner's retirement decision with a concrete rollback
      route. No live data mutation is implied by this plan; coordinate any live
      deployment separately.
- [ ] Make the accepted lift behavior unconditional and remove the flag's
      registry entry, environment/runtime option, obsolete conditional dispatch,
      and flag-specific documentation and tests. Retain substantive semantic
      tests and eager machinery used by other callers.
- [ ] Run affected package suites, authoritative pattern checks when patterns
      change, repository type/format/lint checks, and applicable independent
      gates. Require clean antagonistic and Cubic reviews before merging.

### F5 — Measure and close

- [ ] Repeat F0 after each behavioral or flag change, using matched inputs and
      demanded surfaces. Report changes in access count separately from changes
      in per-access cost, handler cost, initialization and maintenance.
- [ ] Repeat mounted headless/browser and same-/cross-space comparisons; keep
      instrumentation disabled for timing and retain correctness assertions.
- [ ] Publish the evidence and any remaining limitation, update author/runtime
      guidance, and archive this plan and the completed design tracker under the
      [documentation lifecycle](../README.md).

## Out of scope

Sync-selector narrowing and network transfer reduction remain with
[shaped reads and verb results](shaped-reads-and-verb-results.md). This plan
does not infer production latency from local-copy timings, change unrelated
event semantics, or authorize writes to the live lunch poll.
