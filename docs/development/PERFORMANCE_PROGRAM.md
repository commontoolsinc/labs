# Performance Program

Part of the [Engineering Priorities](ENGINEERING_PRIORITIES.md) framework
(speed dimension). This program identifies performance work and feeds projects
into the overall task list. Product owns prioritization across dimensions.

## Why Now

We're ramping towards real users at our 100-day deadline. A usable product is
critical for supporting that goal. Performance work helps us identify and sand
down the most pointy bits — the things that make the product feel broken or
toylike even when it's functionally correct.

## Principles

1. **Correctness before speed.** A fast but broken runtime is worse than a slow
   correct one. Test coverage over changed behavior must exist before the
   optimization ships.

2. **Optimize the critical path.** Cell propagation, pattern compilation,
   rendering, storage I/O, LLM integration — in that order.

3. **Measure, then cut.** No optimization without a benchmark that proves the
   problem and validates the fix. Connect micro-optimizations to user-visible
   outcomes.

4. **Protect what you've gained.** Every improvement should be defended by an
   existing benchmark. The CI regression detector already runs every 4 hours —
   lean on it rather than building new infrastructure.

5. **Balance direct wins with leverage.** We're a tiny team, so we can't
   afford to spend a month on infrastructure before delivering improvements.
   But we also can't afford to keep guessing at bottlenecks because we lack
   basic tooling. Invest in infrastructure when it's meaningfully holding us
   back from identifying or fixing our biggest problems — that's leverage,
   not overhead.

## Metrics We Care About

These are the dimensions of performance that users experience. We don't have
specific targets yet — establishing baselines through profiling is the first
step, and we'll ratchet targets down as we improve.

| Metric | What users experience | Where it lives |
|--------|----------------------|----------------|
| Pattern load time | "How long until I can use this?" | Compilation + storage + traversal + render |
| Reactive update latency | "Does it feel instant when I interact?" | Scheduler + traversal + render |
| Compilation time | "How long after I edit until I see changes?" | ts-transformers + js-compiler |
| Rendering frame time | "Does scrolling/interaction feel smooth?" | html + iframe-sandbox |
| Storage round-trip | "How long to save/load data?" | memory + network |
| LLM time-to-first-token | "Is the AI part working or stuck?" | LLM + network |

## What We Know (and Don't Know)

**What exists today:**
- 14 micro-benchmark files across runner, memory, utils
- CI benchmarks on every push to main (64-core runner), JSON artifacts with
  90-day retention
- Regression detector every 4 hours (median + 2σ, auto-creates GitHub issues)
- Recent wins: compilation cache (~100-500ms saved), schema freeze caching,
  LLM queue batching, scheduler debouncing, refer() caching (~2x)

**What we don't have:**
- No measurement of where wall-clock time actually goes in a user-visible flow
- No breakdown of "pattern load takes Xms: Y% compilation, Z% traversal, ..."
- No profiling data from real usage

**What this means:** The optimization backlog below was identified through
static code analysis — finding provably suboptimal code (O(n) where O(1) is
possible, unnecessary allocations in hot loops, a disabled cache). We have
confidence these are *locally suboptimal*, but we don't know which ones are
*actually the bottleneck*. A 5x speedup on a path that's 2% of wall-clock
time doesn't move the needle.

## How This Works

The performance program runs as a **profile → fix → repeat** loop:

1. **Profile a real user flow.** Open a representative pattern, record a
   trace, identify where wall-clock time goes. This tells us what to work on.

2. **Fix the top bottleneck.** Pick the highest-impact optimization from the
   backlog (or discover a new one from profiling). Write prerequisite tests.
   Ship the fix. Validate with benchmarks.

3. **Repeat.** Re-profile to confirm the improvement and find the next
   bottleneck. The backlog reorders itself based on what profiling reveals.

This process feeds performance tasks into the overall task list. Product
decides priority relative to correctness, capabilities, and other work.

### Getting Started: First Profile

The first step is profiling a real user flow end-to-end. A user-visible flow
spans both the client (browser) and the server (toolshed), and bottlenecks
can live in either. These are two separate profiling sessions with different
setup, but both use Chrome DevTools flame charts and both benefit from
[INFRA-1: Performance marks](#performance-infrastructure) once those exist.

#### Client Profile

Open a representative pattern in Chrome DevTools, record a performance
trace, and read it. This takes an hour and tells us whether compilation,
traversal, rendering, or storage I/O dominates on the client side. No
infrastructure required — just do it once and write down the findings.

#### Server Profile

Many past bottlenecks stem from excessive server queries — these won't
appear in a client trace. To profile toolshed, start it with
`deno run --inspect` and attach Chrome DevTools to the Deno process
(`chrome://inspect`). This gives you the same flame chart experience as
client profiling, just for the server.

For more structured server tracing, toolshed already has OpenTelemetry
instrumentation (request-level spans in `middlewares/opentelemetry.ts`,
memory operation spans in `packages/memory/telemetry.ts`). It's disabled by
default (`OTEL_ENABLED=false`) and requires a collector (Jaeger, etc.), so
`--inspect` is the lower-friction starting point. OTEL becomes valuable
when you want queryable traces ("show me the 10 slowest storage reads")
rather than one-off flame charts.

#### Documenting the Process

We don't have profiling documentation yet (the debugging docs cover logging
and pattern-level tips, but not runtime profiling). Whoever does the first
client or server profile should document the concrete steps — which pattern
to use, how to start the local dev server, how to record the trace, how to
attach to the Deno process, what to look for — in
`docs/development/debugging/profiling.md` so the next person can repeat it.
This is something we'll need to do periodically; it shouldn't require tribal
knowledge.

### Making the Loop Fast

To keep the profile-fix-repeat loop tight, we need a few cheap tools early:

- [INFRA-1: Performance marks](#performance-infrastructure) — ~20 lines of
  code, gives structure to every future profiling session (hours)
- [INFRA-2: Local benchmark comparison](#performance-infrastructure) — see
  results in seconds instead of waiting for CI (hours)
- [INFRA-4: Pattern load benchmark](#performance-infrastructure) — one
  end-to-end number that tells us if optimizations move the needle (days)

## Performance Infrastructure

Infrastructure that makes the profile-fix-repeat loop faster and more
effective. Sorted by value (benefit relative to cost). The cheap items at the
top directly unblock our ability to identify and validate bottlenecks — they
should be picked up early. The expensive items are real investments worth
debating when the timing is right.

| # | Project | Benefit | Cost | Summary |
|---|---------|---------|------|---------|
| INFRA-1 | Performance marks at key boundaries | High | S | Add `performance.mark()` / `performance.measure()` at compilation start/end, first traversal, first render, storage read/write. ~20 lines across 4-5 files. Zero-cost when not observed. Shows up as labeled spans in Chrome DevTools traces. Makes every future profiling session start with structure instead of anonymous function calls. Consider adding as part of existing `logger.time` and `logger.timeEnd` calls. |
| INFRA-2 | Local benchmark comparison | High | S | `deno task bench` wrapper that saves `bench-baseline.json` and diffs against it. See results in seconds instead of waiting for CI. Every optimization project gets faster. |
| INFRA-3 | Selective benchmark filtering | Medium | S | Verify and document `deno bench --filter` for subsystem-specific runs. Faster inner loop when working on a specific area. |
| INFRA-4 | Single "pattern load" benchmark | High | M | One representative pattern that compiles, loads, receives data, and renders. The top-level number that tells you whether an optimization actually moved the user-visible needle. Without this you're optimizing components without knowing if they're the bottleneck. (Partly done in [#3133](https://github.com/commontoolsinc/labs/pull/3133)) |
| INFRA-5 | PR benchmark bot | High | M | CI job on PRs touching critical packages, compares against main, posts before/after comment. We already have the benchmark suite, artifact storage, and comparison logic in `perf-regression.ts`. Catches regressions before merge instead of 4 hours after. (done in [#3125](https://github.com/commontoolsinc/labs/pull/3125)?) |
| INFRA-6 | Benchmark trend visualization | Medium | M | Script that pulls 90 days of benchmark JSON artifacts and produces charts or CSVs. Data already exists but isn't accessible without manual artifact downloads. Spots gradual drift the regression detector misses. |
| INFRA-7 | Automated budget enforcement | High | L | Hard budgets on critical metrics, CI fails if exceeded. Performance becomes a contract. Requires careful calibration for CI-vs-local variance and a warmup period as warnings-only. Risk of false positives creating CI noise. |
| INFRA-8 | End-to-end performance test suite | High | L | Multiple representative user journeys (simple load, 100-cell pattern, LLM pattern, large list) measured wall-clock on every PR. Guarantees user-visible performance is protected, not just micro-benchmarks. Each scenario needs a pattern, test data, and harness. Maintenance scales with scenario count. (Note that the pattern unit tests integration test is the closest we have to that. It also run the backend in-memory, so it happens to measure both client and server in one go.) |
| INFRA-9 | Ratcheting | Medium | L | When a metric improves, automatically lower the budget to lock in the gain. Requires budget enforcement as prerequisite. Compound improvement without discipline overhead. Risk: lucky fast runs ratcheting to unreproducible levels. |
| INFRA-10 | Runtime profiling infrastructure | High | L | Structured traces from running toolshed/shell, queryable programmatically. "Show me the 10 slowest reactive cycles." Transforms profiling from squinting at flame charts to querying data. Significant design work to make it zero-cost when inactive. (Note: `cf test --verbose ...` is useful here) |
| INFRA-11 | Performance dashboard | Medium | L | Hosted page with benchmark results, trends, regression status. Replaces "download artifact, parse JSON, squint." Creates shared visibility and accountability. Frontend work, CI integration, ongoing maintenance. |

## Optimization Backlog

Projects identified through code analysis. **Ordering will change based on
profiling results.** The tiers below reflect our best guess before profiling;
the profile-fix-repeat loop will reorder them based on where time actually
goes.

**Impact:** Critical (hundreds of ms, user-visible) · High (tens of ms, hot
path) · Medium (benchmarks improve, modest user impact) · Low (micro)

**Cost:** S (hours) · M (days) · L (week+)

### Cheap Wins (worth doing regardless of profiling)

| # | Project | Impact | Cost | Summary |
|---|---------|--------|------|---------|
| PERF-3 | Link resolution without JSON.stringify | High | S | `link-resolution.ts:83` allocates via `JSON.stringify` on every cycle-detection step. Replace with null-byte-separated concat (~2x faster on typical inputs). Naive separators like `\|` or `/` cause collisions when path segments contain the separator — use `\0` with a length prefix. [Tests needed.](#perf-3-link-resolution) |

### Likely High-Impact (pending profiling confirmation)

| # | Project | Impact | Cost | Summary |
|---|---------|--------|------|---------|
| PERF-2 | anyOf discriminator fast-path | High | M | `traverse.ts:2023` tries every union branch. Discriminated unions (with `const` property) could resolve in O(1). However: our schemas may not have many discriminated unions in practice, and there's already a type-based pre-pass that rejects non-matching branches early. Actual impact depends on profiling. [Tests needed.](#perf-2-anyof-discriminator) |
| PERF-4 | Engine.evaluate file filtering | High | M | `engine.ts:198` sends all compiled files to sandbox. Filter to only transitively imported files. [Tests needed.](#perf-4-engine-files) |
| PERF-1 | Client-side document caching | Critical | L | IDB cache disabled 8+ months (`cache.ts:1815`). Core issue is invalidation — server selects docs via schema traversal, client can't know what's stale. Candidate strategies: (a) CAS-only caching for content-addressed objects, (b) full space replication with `since`-based incremental sync, (c) local schema query against cached snapshot to produce doc/since pairs, letting the server skip unchanged docs. **Needs measurement first:** how much session data is CAS-addressable, and does the query-local-then-sync approach pay for the extra upstream data and local query? [Tests needed.](#perf-1-document-caching) |

### Address If Bottleneck Emerges

| # | Project | Impact | Cost | Summary |
|---|---------|--------|------|---------|
| PERF-7 | Schema traversal caching | High | M-L | Cache resolved schemas via WeakMap. Profile first to confirm schema resolution dominates traversal time. |
| PERF-8 | Batch storage reads | High | M | N sequential reads during list traversal → single batch. Matters for 50+ item patterns. |
| PERF-9 | transformPropValue memoization | Medium | S-M | Cache cell-to-DOM-attribute transforms between reactive cycles. Profile first. |
| PERF-10 | Scheduler writer index cleanup | Medium | S | Use Set instead of array for per-entity writer list. Matters when many actions write to same entity. [Tests needed.](#scheduler-perf-10) |
| PERF-11 | IPC event serialization | Medium | M | Serialize only the event properties the handler reads. Matters for high-frequency events. |

## Test Prerequisites

Each optimization has correctness properties that must be tested before the
change ships. This is not process overhead — it's the minimum to avoid
shipping regressions.

**<a id="perf-2-anyof-discriminator"></a>PERF-2 (anyOf discriminator):** `mergeSchemaOption` (`traverse.ts:2923`) is
completely untested and has a known TODO about incorrect handling of conflicting
types. Partial discriminated unions (only some branches have the discriminator)
are untested. Nested anyOf has benchmarks but no correctness tests. **Write
these tests first.**

**<a id="perf-3-link-resolution"></a>PERF-3 (link resolution):** Good existing coverage (28 tests). Add 2-3 tests for
cross-space cycles and separator edge cases. The replacement key function must
not collide on path segments containing the separator. **Can ship alongside the
fix.**

**<a id="perf-4-engine-files"></a>PERF-4 (engine files):** No test verifies the sandbox receives all needed files —
current tests pass because the superset always includes everything. **Add
transitive import chain tests before filtering.**

**<a id="perf-1-document-caching"></a>PERF-1 (document caching):** Zero tests for cache-specific behavior. For
CAS-only caching, test: correct storage/retrieval, space isolation, id-is-hash
invariant. **Test scope depends on chosen strategy.**

**<a id="scheduler-perf-10"></a>Scheduler (PERF-10):** No direct test for the `writersByEntity` index. No
glitch-free guarantee test. **Write these before changing the data structure.**
