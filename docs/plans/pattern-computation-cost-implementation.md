# Pattern computation cost: implementation sequence

Status: A1/A2 instrumentation is shipped in
[PR #7246](https://github.com/commontoolsinc/labs/pull/7246). The controlled A0
fixture, accounting and reporting regressions, and dashboard are being reconciled
in [PR #7241](https://github.com/commontoolsinc/labs/pull/7241). A3's local
implementation requires adaptation to the shipped accounting API before review.

This tracker executes the design in
[PR #7155](https://github.com/commontoolsinc/labs/pull/7155), reviewed at commit
`147e7518c9d03bc9808c56e1488d2ae0965ea655`. The design owns the rationale and
scope; this document owns dependencies, implementation slices, acceptance
checks, and the next task. Keep the A–E identifiers aligned with the design. Its
reported durations and access estimates are hypotheses until reproduced here.

The [execution dashboard](../../tools/implementation-progress/README.md) shows
delivery state, review gates, outstanding questions, and observable demos.
Checked items below mean implemented and validated; the dashboard separately
records whether they have landed. Keep both current at implementation
milestones.

## Tracking rules

An unchecked item is pending. Check an item only after its acceptance checks
pass, and attach the implementation PR and validation evidence. A parent is
complete only when its children are complete. An unavailable rig is a named
dependency, never a passing measurement. Keep completed measurement reports
under `docs/history/` with metadata and an index entry; link them here.

Do not expand this work into a TypeScript execution planner, contention repair,
inverse-based aggregates, or a general incremental `reduce`. B3a is explicitly
deferred and does not block completion of the active work.

## Implementation order

| Slice | Design stages        | Prerequisite                                | Reviewable result                                      |
| ----- | -------------------- | ------------------------------------------- | ------------------------------------------------------ |
| 0     | Preparation          | None                                        | This tracker and source reconciliation                 |
| 1     | A0a, A1              | 0                                           | Baseline fixture, counter contract, runtime accounting |
| 2     | A2, A0b              | 1                                           | Attributed per-step counts and regenerated baseline    |
| 3     | A3                   | 2                                           | Opt-in per-run and whole-step budgets                  |
| 4     | A4, A5               | 2                                           | On-screen read benchmark and rig comparison            |
| 5     | C1                   | 0; use 2 for cost evidence                  | Two multi-replica reproductions                        |
| 6     | B1/B2 contracts      | 2; incorporate C1 findings                  | Written index, lookup, and join contracts              |
| 7     | B1, B4               | 6                                           | Incremental grouping and unique-key indexing           |
| 8     | B2, B4               | 7                                           | Keyed lookup and incremental join                      |
| 9     | B3 contracts, B3, B4 | 8                                           | Deterministic named aggregates                         |
| 10    | C2, C3, C4           | 5; use 2 for cost evidence                  | Remote updates work through reactive rows              |
| 11    | B5, B6               | 3, 4, 8, 9; coordinate with 10              | Measured lunch-poll migration                          |
| 12    | E1, E2, E3           | 2 for measurements; 7–9 for operator advice | Measured guidance and warning diagnostic               |
| 13    | D1, D2, D3           | Track throughout; use 2 for comparisons     | Dependency verification and measurements               |
| 14    | Closeout             | Active stages verified                      | Live docs updated and tracker archived                 |

This is a dependency order, not a requirement to wait for every earlier row. C1
and contract research can start early; operator implementations require settled
contracts and working counters. A5 gates the performance claim in B6, not
implementation of an operator. E1's recommendation requires measurement; E3's
replacement advice requires a shipped replacement.

## 0. Prepare the implementation

- [x] Read the design and identify its existing runtime and CLI extension
      points.
- [x] Create the full implementation sequence with explicit acceptance gates.
- [x] Reconcile D3 with the current implementation: `getSnapshotMemo()` in
      [extended-storage-transaction.ts](../../packages/runner/src/storage/extended-storage-transaction.ts)
      selects separate memos by epoch and ambient metadata. D3 must verify
      isolation and measure reuse, rather than assume scoped memoization is
      absent.

## 1–2. Establish measurement: A0, A1, A2

- [x] **A0a — Establish a repeatable workload before instrumentation.**
  - [x] Run
        `deno task cf test packages/patterns/lunch-poll/main.test.tsx
        --verbose --stats-threshold 0`;
        inspect which tally and row reads it actually demands.
  - [x] Specify the options, votes, voters, source revision, demanded output,
        CFC posture, lazy-materialization setting, and execution location. Add a
        controlled fixture if the existing test cannot reproduce the design's
        workload.
  - [x] Separate initialization from one steady-state vote update. Record
        available run counts; leave unavailable access counts unmeasured.
        Disable idempotency verification before using test durations as
        performance evidence, following the performance-investigation skill.
- [x] **A1a — Define the initial accounting contract.** See
      [read accounting](../features/read-accounting.md). Reactive action bodies
      are the initial boundary; event dispatch and commit work must be added
      before claiming whole-step budget coverage.
  - [x] Define proxy access events, actual link crossings, distinct documents
        identified by replica document object, and registered dependencies. Specify
        repeated reads, missing values, enumeration, shallow reads, and memo
        hits. A read activity is not interchangeable with a proxy access.
  - [x] Define per-run ownership, cumulative totals, and per-step aggregation.
        Distinguish a union of documents across a step from a sum of per-run
        cardinalities. Define failure, restart, idempotency verification, nested
        execution, and async completion accounting.
  - [x] Define opt-in configuration and the disabled path. Register any new
        experimental option in the central registry if one is needed.
- [x] **A1b — Implement reactive-action accounting at the operations it
      measures.**
  - [x] Extend `ActionStats` and scheduler recording in
        [telemetry.ts](../../packages/runner/src/telemetry.ts) and
        [timing.ts](../../packages/runner/src/scheduler/timing.ts).
  - [x] Trace both query-result and schema-backed lazy reads before placing
        proxy counters. Count link crossings in the actual resolution and schema
        traversal paths, without counting the same crossing twice.
  - [x] Derive document/dependency accounting from actual transaction reads and
        registration. Preserve read metadata and subscription behavior.
  - [x] Test repeated reads versus distinct documents, cross-space reads, link
        chains, memo hits, shallow dependencies, failures, and isolation between
        actions/runtimes. Verify builtins are counted.
  - [x] Verify disabled accounting allocates no per-read counter state and
        performs no document-set maintenance; measure its overhead against an
        uninstrumented control. See the
        [disabled-probe measurement](../history/development/performance/2026-09-10-read-accounting-probes.md);
        the result is limited to that workload and does not claim zero overhead.
- [x] **A2 — Expose attributed reactive-action counts.**
  - [x] Extend per-step output in
        [test-runner.ts](../../packages/cli/lib/test-runner.ts), sorting by
        access deltas and retaining run counts and authored `src`.
  - [x] Keep builtin/coordinator work visible when no authored site exists. The
        CLI aggregates completed-run events, including removed actions. Avoid
        double-counting shared action IDs and parent/child totals.
  - [x] Test interval resets, multiple runs, zero-work steps, missing source
        locations, and completed runs without consulting graph snapshots.
- [x] **A0b — Regenerate the durable baseline using A1/A2.**
  - [x] Provide one command and checked fixture that regenerate all four
        counters, by action and step, with initialization separate.
  - [x] Record measured evidence and explain differences from the design's
        estimates. A0 is complete only after this pass.

See the
[controlled baseline](../history/development/performance/2026-09-10-lunch-poll-read-baseline.md)
for the fixture, command, execution posture, and counts. No pattern-test
durations are used as performance evidence.

## 3–4. Defend and calibrate measurements: A3–A5

- [ ] **A3 — Add opt-in pattern-test budgets.** The
      [budget contract](read-cost-budgets.md) defines the pending surface,
      execution coverage, and pass/fail demo.
  - [ ] Define the test declaration and diagnostics for per-action-run and
        per-step-through-settle limits, with separate initialization limits.
  - [ ] Include every execution in a step, including builtins, coordinators,
        failed attempts, and short-lived actions according to A1a's contract. Do
        not depend solely on retained graph snapshots for enforcement.
  - [ ] Test exact-boundary pass, one-over failure, one expensive run, and many
        individually cheap runs exceeding the step budget. Verify unbudgeted
        tests preserve their behavior.
- [ ] **A4 — Add the read-side benchmark.**
  - [ ] Follow [BENCHMARKS.md](../development/BENCHMARKS.md); measure one vote
        settling with its tally on screen across declared collection sizes.
  - [ ] Preserve the existing write-burst benchmark as a separate workload.
        Record reads, runs, commits, and timing; assert counts in regression
        tests and report timing as benchmark trends.
- [ ] **A5 — Explain probe/product differences.**
  - [ ] Compare matched inputs in the headless probe and browser, varying worker
        boundary and single-space/cross-space voter links separately.
  - [ ] Record client/server execution posture, demanded surfaces, counters, and
        timings from the process that performs the work.
  - [ ] Confirm the explanation against the deployed board's behavior. Keep
        access or environment requirements explicit if unavailable; do not
        substitute a synthetic result for deployed evidence.

## 5, 10. Repair incremental correctness: C1–C4

- [ ] **C1 — Reproduce both documented failures.**
  - [ ] Add a multi-replica nested-filter case whose reader has not locally
        materialized every vote.
  - [ ] Add a remote element-update case asserting rendered per-row content.
        Start beside the existing lunch-poll keyed-votes integration tests.
  - [ ] Establish failure before repair, or demonstrate that the current system
        already passes the faithful reproduction. Record the cause or evidence
        before deciding what C2/C3 need to change.

  Initial probes cover separately stored same-space votes and voter profiles:
  [independent replicas](../../packages/patterns/integration/reactive-vote-rows.test.ts)
  assert nested-filter membership and derived tally updates;
  [browser tests](../../packages/patterns/integration/reactive-vote-rows-browser.test.ts)
  assert remotely updated row colors and resolved profile names. The browser
  subscribes before the writer creates the linked entities. Headless result
  reads explicitly pull data, so browser rendering owns the passive-update
  check. C1 remains open for cold cross-space links, removals and reconnects,
  ranking changes, profile-only updates, and production-shaped nested swatches.
  These probes do not authorize removing the lunch-poll workaround.

- [ ] **C2 — Repair partial materialization.** Verify complete inputs under cold
      reads, remote inserts/removals, and reconnect where relevant.
- [ ] **C3 — Repair remote row invalidation.** Verify affected rows update,
      stable element identities survive, and untouched rows do not rerun.
- [ ] **C4 — Restore reactive lunch-poll rows.** Remove the workaround and its
      explanatory comment only after both regressions pass. Re-run A4 and
      coordinate with B5 to keep one coherent pattern migration.

## 6–9. Complete the collection algebra: B1–B4

- [ ] **B1 contract — Specify `groupBy` and `keyBy` separately.**
  - [ ] Key domain and equality, including resolved link identity and
        retargeting a key link without editing its containing element.
  - [ ] Duplicate-key handling that remains deterministic for unordered input;
        missing extracted keys and absent lookups.
  - [ ] Group membership order, group enumeration order, output types, lookup
        surface, and identity across removal/reinsertion.
  - [ ] Bound invalidation to affected keys; state initialization, update,
        lookup, and storage complexity.
- [ ] **B2 contract — Specify lookup and join.** Decide join cardinality,
      unmatched rows, duplicate matches, output ordering/identity, link
      retargeting, and cleanup before building the join.
- [ ] **B1 implementation — Build grouping and unique-key indexing.**
  - [ ] Reuse collection element-identity/reconciliation rules from existing
        builtins; cover primitives, linked elements, and inline values.
  - [ ] Wire builtin registration, replayability, `Cell` methods and reactive
        operation list, author-facing types, and transformer lowering.
  - [ ] Test inserts, edits, moves between keys, removals, reorder, duplicate
        keys, link retargeting, replay, and teardown. Assert unaffected-key
        consumers do not rerun and measure maintenance work as size grows.
- [ ] **B2 implementation — Build keyed lookup, then join.** Test lookup and
      join contracts, both-side updates, and affected-row-only invalidation.
- [ ] **B3 contract — Specify deterministic aggregates.**
  - [ ] Define combine order from the current collection, independent of edit
        history; define floating-point behavior explicitly.
  - [ ] Define ties, empty collections, NaN, infinities, and signed zero for
        `sum`, `min`, `max`, `minBy`, and `maxBy`; define predicate counting.
- [ ] **B3 implementation — Add `count`, `sum`, `min`/`max`, `minBy`/`maxBy`.**
  - [ ] Maintain partial aggregates using existing element identities and
        deterministic combination; avoid inverse subtraction.
  - [ ] Reach identical results through different insertion, deletion, reorder,
        and edit histories. Test count bounds on single-element updates and
        initialization separately.
  - [ ] Keep ordinary `reduce` as the full-rerun order-dependent operation.
- [ ] **B4 — Publish contracts and complexity with each operator.** Update
      public doc comments, pattern-author documentation, and executable examples
      in the same slice that ships the API.

**Deferred B3a:** Reconsider restricted append folds only after B1–B3 ship and a
remaining use case justifies them. Requires a separate contract excluding
whole-array access and mutable accumulator aliasing; no active checkbox here.

## 11. Validate the motivating pattern: B5–B6

- [ ] **B5 — Rewrite `tallyOptions` using the shipped operators.** Preserve vote
      colors, voter identity, ranking, and viewer-specific behavior; validate
      the existing pattern tests and multi-replica behavior.
- [ ] Add measured per-run and steady-state step budgets for the hot path.
- [ ] **B6 — Measure savings and maintenance together.** Compare the same
      operation before/after on both probe and deployed-equivalent rigs, then
      validate against deployed behavior after A5. Report accesses, runs, nodes,
      commits, and durations. Do not call fewer reads alone a win.

## 12–13. Guidance and related runtime work: D, E

- [ ] **E1 — Measure identical `computed` and `lift` collection loops** under
      current defaults and compare declared read width and access counts.
- [ ] **E2 — Publish the measured advice** where pattern authors encounter
      collections, `computed`, and `lift`. Explain nested-scan cost and use only
      available operators in replacement examples.
- [ ] **E3 — Add a transformer warning** through the existing diagnostic
      collector. Test recognizable nested reactive scans and negative cases
      involving plain arrays and unrelated scopes; inspect warning volume across
      authored patterns before shipping. Escalation to error requires separate
      evidence about false positives.
- [ ] **D1 — Follow the remaining lazy-materialization work** in its
      [own plan](lazy-cell-materialization.md), including handlers and flag
      removal. Keep implementation ownership there.
- [ ] **D2 — Re-run the A baseline when that dependency changes** and separate
      reduced access count from reduced per-access cost.
- [ ] **D3 — Verify scoped snapshot memoization and measure its effect.**
      Inspect existing snapshot-memo tests for metadata/epoch isolation,
      invalidation, and journaling correctness; add missing coverage only where
      needed. Measure label-view reuse before proposing further work.

## 14. Validation and closeout

- [ ] Each code slice runs relevant focused tests plus the touched packages'
      test tasks, repo-wide `deno fmt --check`, `deno lint`, and
      `deno task
      check`. Pattern changes also run authoritative
      `deno task cfcheck`.
- [ ] Browser-launching checks on macOS run outside the sandbox. Follow
      [TESTING.md](../development/TESTING.md) and event-driven waiting rules.
- [ ] Run applicable independent gates: documentation examples, history index,
      conflict markers, package cycles, and any changed CLI surface,
      experimental options, skills, or transformer fixtures.
- [ ] Review every implementation slice through the `cf-review` skill; attach
      the exact validation scope and unresolved limitations.
- [ ] Confirm every active stage has evidence, keep deferred work explicit,
      update live feature/author docs, and archive the completed tracker
      following [the documentation lifecycle](../README.md).

## Validation evidence for the initial A1/A2 slice

- The runner package suite passes; the final focused counter/report tests and
  existing proxy, schema-view, memoization, and timing regressions pass.
- The CLI package suite has two color-output failures also reproduced against an
  untouched archive of the base revision; its remaining tests pass.
- Repository type checking, formatting, lint, checked documentation examples,
  and package-cycle checks pass.
- The lunch-poll functional test passes with verbose read-cost reporting.
- The
  [probe comparison](../history/development/performance/2026-09-10-read-accounting-probes.md)
  records the measurement method and its limits.

## Next task

Define A3's budget declaration and extend measurement to event dispatch and
commit work before enforcing whole-step budgets. Preserve separate
initialization limits and include short-lived actions and failed attempts. The
controlled A0 fixture is available for count comparisons; A4/A5 still need
browser and cross-space measurements before product performance claims. Do not
implement collection operators before the measurement and semantic gates above
are satisfied.
