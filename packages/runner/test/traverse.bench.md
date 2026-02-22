# Traverse Benchmark Runbook

This runbook standardizes how we collect and compare `traverse` benchmark data.

## Environment

- Run from repo root on a mostly idle machine.
- Prefer consistent power mode (avoid switching between battery
  saver/performance).
- Close heavy background apps/tabs while capturing benchmark JSON.
- Deno version should match team baseline (currently observed in this branch:
  `Deno/2.6.4`).

## Commands

Capture benchmark output as JSON:

```sh
cd packages/runner
mkdir -p test/bench-results

deno bench --allow-read --allow-write --allow-net --allow-ffi --allow-env --no-check test/traverse.bench.ts --json > test/bench-results/<name>.json
```

Suggested names:

- `traverse-baseline.json`
- `traverse-after-<change>.json`

## Comparison Workflow

1. Capture at least one baseline and one after-change run.
2. Compare `results[0].ok.avg` for each benchmark name.
3. Re-run if a change is surprising or near noise-level.

Minimal comparison helper:

```sh
node - <<'NODE'
const fs = require('fs');
const base = JSON.parse(fs.readFileSync('test/bench-results/traverse-baseline.json', 'utf8'));
const next = JSON.parse(fs.readFileSync('test/bench-results/traverse-after-change.json', 'utf8'));
const toMap = (j) => Object.fromEntries(j.benches.map((b) => [b.name, b.results[0].ok.avg]));
const b = toMap(base);
const n = toMap(next);
for (const name of Object.keys(n)) {
  const pct = ((n[name] - b[name]) / b[name]) * 100;
  console.log(`${name}: ${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`);
}
NODE
```

## Interpreting Results

- Use `avg` for quick comparisons, but check `p75`/`p99` when variance seems
  high.
- Treat small shifts (roughly under 3%) as potential noise unless repeated.
- Require at least one confirmatory rerun for large wins/regressions before
  deciding.
- Keep correctness checks (`deno lint` + targeted `deno test`) in the same
  iteration as perf checks.

## Tracking

- Keep JSON artifacts local during iteration.
- Summarize final deltas in `TEMP_traverse_optimization_tasks.md`.
- Before merge, either:
  - remove temporary artifacts/docs, or
  - promote them to permanent docs if they remain useful.
