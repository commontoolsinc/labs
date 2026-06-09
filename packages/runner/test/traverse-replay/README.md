# Traverse capture/replay harness

Realistic, repeatable benchmark + regression infrastructure for the traversal
machinery in `src/traverse.ts`. The synthetic `*.bench.ts` micro-benches don't
reflect production traversal load; this harness captures real workloads from
pattern/integration test runs and replays them deterministically.

## Pieces

| File                             | Role                                                       |
| -------------------------------- | ---------------------------------------------------------- |
| `../../src/traverse-recorder.ts` | Env-gated capture hooks (fixture format lives here too)    |
| `replay.ts`                      | Replays a fixture; extracts the oracle and counter metrics |
| `goldens.ts`                     | Golden storage + human-oriented oracle diffing             |
| `regen-goldens.ts`               | Regenerates goldens (deliberate semantic changes only)     |
| `fixtures/*.json.gz`             | Captured workloads (corpus + invocation trace)             |
| `goldens/*.golden.json.gz`       | Baseline oracles, asserted by `../traverse-replay.test.ts` |
| `../traverse-replay.bench.ts`    | `deno bench` over the fixtures (CI: `test/*.bench.ts`)     |

## Capturing a fixture

Capture works in any in-process Deno run of the runtime (pattern tests, runner
tests, integration tests, server query code):

```bash
CF_TRAVERSE_CAPTURE=/tmp/my-fixture.json \
  deno task cf test packages/patterns/notes/notebook.test.tsx
gzip -9 /tmp/my-fixture.json
mv /tmp/my-fixture.json.gz packages/runner/test/traverse-replay/fixtures/my-fixture.json.gz
cd packages/runner && deno run --allow-read --allow-write test/traverse-replay/regen-goldens.ts
```

The recorder logs every `SchemaObjectTraverser.traverse()` call (address,
selector, link, `includeMeta`, shared context/memo identity) and snapshots each
doc read during traversal into the corpus. `CF_TRAVERSE_CAPTURE_MAX` caps
recorded invocations (default 20k). Edit `meta` in the fixture JSON to give it a
name/description before gzipping.

Fidelity caveats (fine for benchmarking/regression): docs are captured
first-wins, so mid-run writes replay with the earliest value; client invocations
replay with `StandardObjectCreator`, so cell/proxy construction cost is excluded
while traversal control flow is preserved.

## The oracle

`replayFixture(fixture, { collectOracle: true })` extracts three things any
behavior-preserving optimization must keep byte-identical:

1. **Result hashes** per invocation (truncated structural hashes).
2. **The read set** — every `tx.read`/`readOrThrow` address + option flags. This
   is the scheduler's invalidation surface: dropping a read mark breaks
   reactivity invisibly, and no unit test catches it. (Verified: commenting out
   a single `READ_FOR_SCHEDULING` read in `traverseDAG` fails the test with
   "reads missing".)
3. **Schema-tracker contents** for shared/`includeMeta` contexts — the
   server-side subscription surface.

`deno task test` runs `traverse-replay.test.ts`, which asserts replay matches
the goldens. An intended semantic change regenerates goldens via
`regen-goldens.ts`; the golden diff in the PR is the review artifact.

## Benchmarks

```bash
# CI shape (notebook sliced to its first 500 invocations):
deno bench --allow-read --allow-env --no-check test/traverse-replay.bench.ts

# Full replay (the optimization-loop metric) + counter attribution:
CF_REPLAY_BENCH_FULL=1 BENCH_DIAGNOSTICS=1 \
  deno bench --allow-read --allow-env --no-check test/traverse-replay.bench.ts
```

Counters (schema calls, anyOf branches/fast-rejects, getDocAtPath, memo hits)
are deterministic where wall time is noisy: claimed wall-time wins should come
with a counter explanation.

## Current fixtures

- `notebook-test` — notebook pattern test; 12.8k invocations, 126 docs, 972
  distinct selectors, anyOf-heavy vnode load (~330k anyOf branch evaluations).
  The main client-shaped metric (~9s full replay). Notably, ~45% of recorded
  invocations fail validation (INVALID_TYPE etc.) — real reactive-read load
  includes heavy fast-fail traffic.
- `shopping-list-test` — small array/handler-heavy client load; fast inner-loop
  fixture (~14ms).
- `piece-query-legacy` — a captured server query dataset (36 docs);
  server-shaped (`includeMeta`, single big traversal). Converted from the old
  `integration/traverse_timing.test.ts` dataset, which predated the charm→piece
  rename: that test was mechanically renamed to query `selectedPiece` while its
  data still had `selectedCharm`, so it stopped traversing its own data. The
  fixture keeps the original `selectedCharm` selector and keys the corpus by
  the capture space (which links in the docs carry explicitly). The timing test,
  its JSON, and the one-off converter have been removed; this fixture is the
  canonical copy of the dataset.
