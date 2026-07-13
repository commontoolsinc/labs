# Benchmarks

How the repository's `deno bench` files run in CI, where their results are
charted, and the constraints a bench file must satisfy for that tracking to
work.

## The pipeline

The Benchmarks workflow (`.github/workflows/benchmarks.yml`) runs every four
hours on a schedule, on the dedicated runner group so results stay comparable
across runs. It runs `deno bench --json` over `packages/runner/test/*.bench.ts`
plus two explicitly listed files in `packages/utils`, and uploads stdout as the
`bench-results` artifact (90-day retention). A bench file outside those paths
does not run in CI until it is added to the workflow. The workflow's manual
trigger measures a specific commit.

The team ops dashboard charts benchmark trends on its `/bench` page, sampling
one successful run per four-hour window from those artifacts. Each
benchmark's series is identified by its origin file, group, and name.

Benchmark numbers are not gated: the per-PR performance gate
(`tasks/perf-check.ts`) covers CI job, step, and test timings plus the
coverage-debt ratchet, and never ingests benchmark results, so a bench
regression shows up as trend drift on the dashboard rather than as a failing
check.

Most packages with benches define a `bench` task for running them locally
(see `packages/runner/deno.jsonc`); otherwise invoke `deno bench` on a
single file.

## Constraints on bench files

**Stdout must stay pure JSON.** The workflow redirects all of stdout to
`results.json`. One stray line printed by any bench file corrupts the
artifact for every benchmark in the run, not just the offending file. This
applies to module-scope code as well as bench bodies. Write diagnostics with
`console.error`, which goes to stderr and shows up in the workflow log. A
stray diagnostic once corrupted every benchmark artifact for five weeks
before anyone noticed.

**Names identify chart series.** The dashboard tracks each benchmark by its
origin file, group, and verbatim name. Renaming a bench or its group breaks
the series: history stays under the old name and the renamed bench starts
over. So:

- Keep names stable. Never interpolate values that change as unrelated commits
  land: content hashes, byte counts, module counts, dates. If a name must
  identify a module, derive a label from its source filename, not from its
  content. Log volatile sizes to stderr instead.
- Keep names short. The dashboard has little horizontal room for series
  labels, and the origin file and group already carry context, so the name
  should not repeat them.
- Keep names unique within a file. `Deno.bench` accepts duplicate names
  without an error and reports them as a single benchmark whose results array
  holds one entry per duplicate; a consumer reading one result per name
  silently drops the rest.

`packages/runner/test/esm-verifier.bench.ts` shows the pattern: short stable
names, per-module labels derived from source paths, sizes logged to stderr.
