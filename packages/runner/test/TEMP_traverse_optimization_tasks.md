# TEMP: Traverse Optimization Tasks

This is a temporary working checklist for the traversal optimization effort.

## Branch

- [x] Create branch `perf/traverse-optimization-benchmarks`

## Benchmark Baseline

- [x] Add targeted benchmark suite: `packages/runner/test/traverse.bench.ts`
- [ ] Capture baseline benchmark output (JSON):
  - `cd packages/runner && deno bench --allow-read --allow-write --allow-net --allow-ffi --allow-env --no-check --json test/traverse.bench.ts > test/bench-results/traverse-baseline.json`
- [ ] Add a short benchmark runbook documenting:
  - machine/setup notes
  - command line and filters
  - interpretation guidance (median vs variance)

## Optimization Work Items

- [ ] `getAtPath` path walking:
  - replace `remaining.shift()` loop with index-based traversal to avoid O(n^2)
    behavior on deep paths
- [ ] Tracker/deep-equality hot paths:
  - reduce repeated deep equality scans in `MapSet` and `CompoundCycleTracker`
  - evaluate schema/key interning (stable IDs) for faster lookups
- [ ] Schema-path memoization:
  - cache `schemaAtPath`/resolved-schema lookups by `(schema identity, path)`
- [ ] Schema traversal memoization:
  - evaluate memoizing `(address, schema)` for repeated branch traversals
    (`anyOf`/`allOf`/`oneOf`)
- [ ] Allocation reduction:
  - reduce temporary array/object churn in hot traversal loops
- [ ] asCell/asStream fast paths:
  - ensure array/object boundary handling minimizes unnecessary work in
    `traverseCells=false` mode

## Validation

- [ ] Re-run targeted traversal benchmarks and write after-results JSON
- [ ] Compare baseline vs after and summarize wins/regressions
- [ ] Run correctness checks:
  - `deno test -A packages/runner/test/traverse.test.ts packages/runner/test/query.test.ts`
  - `deno fmt`
  - `deno lint`

## Exit Criteria

- [ ] No correctness regressions in traversal/query tests
- [ ] Benchmarks demonstrate measurable improvement in at least the top 2
      hotspots
- [ ] Remove this TEMP file (or convert to permanent doc) before merge
