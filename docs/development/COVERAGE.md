# Code coverage in CI

This repository measures code coverage in two different ways, because it runs
two different kinds of code. Keeping the two apart is the key to reading the
numbers correctly and to deciding which test job should collect which kind of
coverage.

## Two kinds of code, two coverage mechanisms

### Runtime and framework code is measured by Deno's V8 coverage

The packages that make up the Common Fabric runtime (api, runner, identity,
memory, and the rest) are ordinary TypeScript modules. Deno loads and runs them
directly, so Deno's built-in V8 coverage can record which of their lines ran. A
CI job turns this on by setting the `DENO_COVERAGE_DIR` environment variable.
After the tests finish, `tasks/write-coverage-lcov.ts` converts the raw V8
profile into an LCOV file, and the job uploads it as a `coverage-profile-*`
artifact. Most test jobs set `DENO_COVERAGE_DIR`, including both pattern
integration jobs.

### Authored pattern code is measured by transformer instrumentation

Patterns (the user programs under `packages/patterns`) are not loaded the way an
ordinary module is. Each pattern is compiled through the Common Fabric
transformer pipeline and then run inside a sandbox. Deno's V8 coverage never
sees the authored pattern statements execute, so it cannot report which lines of
a pattern ran.

To measure that, the `cf test` command can turn on a separate mechanism. When
the `CF_PATTERN_COVERAGE_DIR` environment variable is set (or the
`--pattern-coverage-dir` flag is passed), the `cf test` runner builds a
`PatternCoverageCollector`. The transformer then injects a coverage "hit" call
in front of each authored statement, and the collector writes one
`*.pattern-coverage.lcov` file per test. The line numbers in that file point
back at the authored pattern source.

Two properties of this mechanism are worth keeping in mind.

- The counters are statement based. A single statement that spans several lines
  marks its whole source range as run the moment the statement is reached. The
  number answers "did this statement run", not "was every line independently
  exercised".
- Coverage records that a line ran. It never records that a test checked the
  result of running that line. A test that drives a pattern through a flow
  without asserting anything still marks those lines covered.

`CF_PATTERN_COVERAGE_DIR` is read in exactly one place: the `cf test` command in
`packages/cli/commands/test.ts`. A job that runs patterns through a plain
`deno test` invocation, or by talking to a running Toolshed server, does not go
through `cf test`. Setting the variable on such a job has no effect at all.

## How the two feed the coverage gate

`tasks/perf-check.ts` downloads every `coverage-profile-*` artifact, joins all
the LCOV files together, and hands them to `tasks/coverage-metrics.ts`. That
code walks the tracked source files under `packages` and `tasks`, and for each
file counts how many of its lines no test covered. The top-level `scripts`
directory is excluded from this gate. The counts roll up into
`coverage-debt: <group> uncovered lines` metrics, for example
`coverage-debt: packages/patterns uncovered lines`, and the performance check
gates a pull request on them.

Authored pattern files under `packages/patterns` are tracked source files, so
their uncovered lines count toward `coverage-debt: packages/patterns`. The only
job that currently feeds covered-line data for those authored files is
`pattern-unit-test`, because it is the only job that runs patterns through
`cf test` with `CF_PATTERN_COVERAGE_DIR` set.

One detail of the gate's accounting matters when reasoning about pattern
coverage. For a tracked file that has any LCOV record, the gate counts only the
lines named in that record that were never hit. For a tracked file with no LCOV
record at all, every tracked line counts as uncovered. Pattern instrumentation
emits a record line only for statements it could instrument, which is a subset
of the file's lines. So the first time any test produces a pattern-coverage
record for a previously unrecorded pattern file, that file's uncovered-line
count drops both because real lines became covered and because the lines the
instrumentation never names leave the denominator. The second effect is an
accounting artifact, not new test strength.

## A combined report for IDEs

The same `coverage-profile-*` artifacts feed a second consumer. On `main`, the
`attest-binaries` job downloads all of them, runs
`tasks/combine-coverage-lcov.ts` to merge them into one LCOV file, and uploads
that file to the build-artifacts bucket next to the release tarball. The point
is to give someone working in an IDE a single file that shows coverage for the
whole repository, instead of one fragment per CI job.

Two things happen during the merge. The source paths in each fragment are
absolute paths rooted at whichever runner produced them, so they are rewritten
to repository-relative paths that an IDE can map onto a local checkout. Records
for the same source file are then combined into one, with the per-line hit
counts added together, so a file exercised by several jobs is reported once with
its combined coverage.

The merged file carries line coverage only. LCOV identifies a function by its
name, and `deno coverage --lcov` can emit several functions with the same name
in one file (a free function and a method, for example), so function and branch
records cannot be merged back together reliably from the fragments alone. Line
coverage is what an IDE uses to colour the gutter, which is what this file is
for.

To download the report for a given commit:

```
gsutil cp gs://commontools-build-artifacts/workspace-artifacts/labs-<commit-sha>.lcov .
```

## Which job collects which coverage

| Job | Runtime (V8) coverage | Authored-pattern coverage |
| --- | --- | --- |
| `pattern-unit-test` | yes | yes (`cf test` with `CF_PATTERN_COVERAGE_DIR`) |
| `pattern-integration-test` | yes | no |
| `pattern-reload-integration-test` | yes | no |

The pattern unit job runs each `packages/patterns/**/*.test.tsx` file through
`cf test` in-process. The two integration jobs run browser-driven `deno test`
files against a running Toolshed server.

The compile byte cache is available to `cf test` through
`CF_COMPILE_CACHE_FILE`. Coverage and non-coverage compiles use different cache
keys. Coverage cache entries also carry the spans registered during the
transform, so a restored coverage compile can rebuild the current collector
before the cached module bytes run. The `pattern-unit-test` job wires both
`CF_PATTERN_COVERAGE_DIR` and `CF_COMPILE_CACHE_FILE`, which lets CI reuse
coverage-transformed module bytes between runs without mixing them with ordinary
compiled bytes.

## Why the two integration jobs do not set `CF_PATTERN_COVERAGE_DIR`

Adding `CF_PATTERN_COVERAGE_DIR` to `pattern-integration-test` or
`pattern-reload-integration-test` was considered and deliberately not done, for
four reasons.

1. It would do nothing as written. Both jobs run their tests with `deno test`,
   not `cf test`, and `CF_PATTERN_COVERAGE_DIR` is read only by `cf test`. The
   variable would sit in the job's environment unread, which is worse than
   absent because it suggests coverage is being collected when none is.

2. Making it work would mean crossing a process boundary. These tests run the
   pattern inside a sandbox in a headless browser that talks to a separate
   Toolshed server. The "hit" calls happen in that sandbox, with no in-process
   collector to receive them and write LCOV. Collecting them would require new
   plumbing to carry hit data back across the browser and server boundaries.

3. It would weaken the pressure the gate puts on test quality. The coverage-debt
   gate currently rewards focused pattern unit tests, which run in-process,
   assert on results, and are fast. If broad end-to-end flows counted toward
   pattern coverage, the gate could be satisfied by incidental execution in an
   integration test that asserts little, so coverage debt would fall without the
   matching rise in verification strength.

4. It would distort the gate's numbers through the accounting artifact described
   above. Crediting integration runs would flip many pattern files from the
   full-file denominator to the narrower instrumented-statement denominator, so
   reported debt would drop for reasons unrelated to new testing.

The net effect on metric quality is that crediting integration runs would trade
a smaller, bounded source of false negatives for a larger source of false
positives and a less faithful, more gameable gate.

## Known limitations and possible future work

- False negatives exist today. A pattern line that only an integration test
  exercises is counted as uncovered, because no integration job collects pattern
  coverage. This understates true coverage for the patterns that are reachable
  only through end-to-end flows. The trade is deliberate: the alternative above
  inflates the numbers more than this understates them.

- The record-versus-no-record denominator difference is a pre-existing property
  of the gate, not specific to integration jobs. If pattern coverage is ever
  expanded, normalizing the denominator (always scoring a pattern file against
  the same line set whether or not it has a record) would make the numbers
  easier to trust.

## Related documentation

- [TESTING.md](TESTING.md) — how to run the test suites whose execution this
  coverage is measured from.
- [CI_PERFORMANCE.md](CI_PERFORMANCE.md) — the coverage-debt baseline and ratchet
  markers (`NEW_PERF_BASELINE` and `NEW_COVERAGE_BASELINE`) that gate a pull
  request on the metrics described here.
- [../common/workflows/pattern-testing.md](../common/workflows/pattern-testing.md)
  — writing the pattern unit tests that the `pattern-unit-test` job runs through
  `cf test`, which is the only source of authored-pattern coverage.
