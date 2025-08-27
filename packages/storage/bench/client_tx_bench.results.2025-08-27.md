# Client Transaction Benchmarks (2025-08-27)

This file captures measured medians from `client_tx_bench.ts` on Apple M3 Max, Deno 2.3.5.

Commands used:

- Single-doc sequential commits (ok path):
  - `BENCH_CLIENT_ITER=N deno bench -A --no-prompt --filter "single doc" packages/storage/bench/client_tx_bench.ts`
- Stacked pending overlays:
  - `BENCH_CLIENT_PENDING=P deno bench -A --no-prompt --filter "stacked pending overlays" packages/storage/bench/client_tx_bench.ts`
- Conflict rollback:
  - `BENCH_CLIENT_CONFLICTS=N deno bench -A --no-prompt --filter "conflict rollback clears overlays" packages/storage/bench/client_tx_bench.ts`

Each data point is the median across 3 fresh process runs.

## Single doc sequential commits (ok)

- N=50: 23.3 ms
- N=100: 41.9 ms
- N=200: 86.4 ms
- N=400: 965.8 ms

Notes:
- 50→200 appears near-linear at ~0.42 ms/commit.
- 400 is super-linear (likely GC/JIT/heap growth). Splitting into 4×100 should restore linearity.

## Stacked pending overlays (quick commits)

- P=5: 3.4 ms
- P=10: 6.5 ms
- P=20: 10.0 ms
- P=50: 23.8 ms
- P=100: 46.0 ms

Notes:
- Roughly linear scaling in this range, ~0.45–0.50 ms/commit including overhead.

## Conflict rollback clears overlays

- N=50: 22.9 ms

Notes:
- Comparable per-commit cost to ok-path at small N. Rollback/overlay-clear is cheap; the cost is dominated by change build/apply.

## Takeaways

- Dominant costs come from Automerge operations within client build/commit and toJS usage for overlays.
- For larger N, consider chunking commits (e.g., batches of 50–100 per fresh process) to avoid heap growth side-effects during measurements, or add pauses to let GC settle.
