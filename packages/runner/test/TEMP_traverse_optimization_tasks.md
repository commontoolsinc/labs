# TEMP: Traverse Optimization Tasks

This is a temporary working checklist for the traversal optimization effort.

## Branch

- [x] Create branch `perf/traverse-optimization-benchmarks`

## Benchmark Baseline

- [x] Add targeted benchmark suite: `packages/runner/test/traverse.bench.ts`
- [x] Add end-to-end benchmark suite:
      `packages/runner/test/traverse-e2e.bench.ts`
- [x] Add mocked retriever deep-link benchmark suite:
      `packages/runner/test/traverse-mocked-retriever.bench.ts`
- [x] Capture baseline benchmark output (JSON):
  - `cd packages/runner && deno bench --allow-read --allow-write --allow-net --allow-ffi --allow-env --no-check --json test/traverse.bench.ts > test/bench-results/traverse-baseline.json`
- [x] Add a short benchmark runbook documenting:
  - machine/setup notes
  - command line and filters
  - interpretation guidance (median vs variance)
  - `packages/runner/test/traverse.bench.md`

## Optimization Work Items

- [x] `getAtPath` path walking:
  - replace `remaining.shift()` loop with index-based traversal to avoid O(n^2)
    behavior on deep paths
- [x] Tracker/deep-equality hot paths:
  - reduce repeated deep equality scans in `MapSet` and `CompoundCycleTracker`
  - evaluate schema/key interning (stable IDs) for faster lookups (still open)
- [x] Schema-path memoization evaluation:
  - attempted cache for `schemaAtPath`/resolved-schema by schema identity + path
  - reverted due measured regressions (notably `asCell` array/object and
    `anyOf`)
- [ ] Schema traversal memoization:
  - evaluate memoizing `(address, schema)` for repeated branch traversals
    (`anyOf`/`allOf`/`oneOf`)
- [x] Allocation reduction:
  - reduce temporary array/object churn in hot traversal loops
  - removed redundant `...curDoc` object spread churn in `getAtPath` loop
- [x] asCell/asStream fast paths:
  - ensure array/object boundary handling minimizes unnecessary work in
    `traverseCells=false` mode
  - remove hot-path `anyOf`/`oneOf` sorting allocations (two-pass evaluation)
  - memoize `asCellOrStream` only for schemas with `anyOf`/`oneOf`
  - keep direct fast-path checks for simple `{ asCell: true }` /
    `{ asStream: true }` schemas

## Validation

- [x] Re-run targeted traversal benchmarks and write after-results JSON
- [x] Compare baseline vs after and summarize wins/regressions
- [x] Run correctness checks:
  - `deno test -A packages/runner/test/traverse.test.ts packages/runner/test/query.test.ts`
  - `deno fmt`
  - `deno lint`

### Captured result artifacts

- `packages/runner/test/bench-results/traverse-baseline.json`
- `packages/runner/test/bench-results/traverse-after-getAtPath-index.json`
- `packages/runner/test/bench-results/traverse-after-getAtPath-and-trackers.json`
- `packages/runner/test/bench-results/traverse-after-getAtPath-trackers-alloc.json`
- `packages/runner/test/bench-results/traverse-after-asCell-memo-options-final.json`
- `packages/runner/test/bench-results/traverse-e2e-current.json`
- `packages/runner/test/bench-results/traverse-e2e-current-rerun.json`
- `packages/runner/test/bench-results/traverse-mocked-retriever-r1.json`
- `packages/runner/test/bench-results/traverse-mocked-retriever-r2.json`
- `packages/runner/test/bench-results/traverse-mocked-retriever-r3.json`

### Latest benchmark deltas (final vs baseline)

- `getAtPath deep object path`: `-33.45%`
- `getAtPath link chain resolution`: `-19.78%`
- `schema anyOf branch-heavy`: `-22.37%`
- `schema oneOf exact-match`: `-20.13%`
- `schema allOf merge-heavy`: `-15.00%`
- `asCell object property boundary (traverseCells=false)`: `-21.94%`
- `asStream object property boundary (traverseCells=false)`: `-18.71%`
- `asCell array boundary (traverseCells=false)`: `-27.32%`
- `asCell array deep traversal (traverseCells=true)`: `-23.46%`

### Mocked retriever deep-link benchmark (schema outcome comparison)

- Fixture: deep linked graph (`depth=48`), mock `ObjectStorageManager` backing
  `ManagedStorageTransaction`, no storage backend overhead.
- Match case: all required fields present
- Mismatch case: one deep `meta.marker` required field missing
- 3-run mean (`avg`): match `13.169ms`, mismatch `26.659ms`
- Mismatch vs match delta: `+102.64%` (about `2.03x` slower)

## Exit Criteria

- [x] No correctness regressions in traversal/query tests
- [x] Benchmarks demonstrate measurable improvement in at least the top 2
      hotspots
- [ ] Remove this TEMP file (or convert to permanent doc) before merge
