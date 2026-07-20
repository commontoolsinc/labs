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

Do not name a source file so that its path ends in `test.ts` (or `test.tsx`,
`test.js`, `test.mjs`, `test.jsx`). `deno coverage` takes those for test files
and leaves them out of the report, even though V8 records them and even if
`--exclude` is overridden. The debt metric reads a missing report entry as a
file no test ever loaded and charges every one of its lines, so a well-tested
file scores as entirely uncovered. This is why the `cf test` command lives in
`commands/test-command.ts`.

### Authored pattern code is measured by transformer instrumentation

Patterns (the user programs under `packages/patterns`) are not loaded the way an
ordinary module is. Each pattern is compiled through the Common Fabric
transformer pipeline and then run inside a sandbox. Deno's V8 coverage never
sees the authored pattern statements execute, so it cannot report which lines of
a pattern ran.

To measure that, a `PatternCoverageCollector` is attached to the runtime. The
transformer then injects a coverage "hit" call in front of each authored
statement, and the collector receives the hits; the line numbers it records
point back at the authored pattern source. There are two ways a runtime gets a
collector:

- The `cf test` command builds one when the `CF_PATTERN_COVERAGE_DIR`
  environment variable is set (or the `--pattern-coverage-dir` flag is passed)
  and writes one `*.pattern-coverage.lcov` file per test. This is the pattern
  unit path.
- A runtime constructed with `RuntimeOptions.patternCoverage` set instruments
  every compile it performs, including the content-addressed cell-cache path a
  piece load takes. The instrumented compile is keyed as a distinct cached
  variant, so a coverage-on runtime never serves the uninstrumented bytes an
  ordinary compile stored. This is how the browser worker collects coverage in
  the integration path (see below).

These properties of this mechanism are worth keeping in mind:

- The counters are statement based. A single statement that spans several lines
  marks its whole source range as run the moment the statement is reached. The
  number answers "did this statement run", not "was every line independently
  exercised".
- Coverage records that a line ran. It never records that a test checked the
  result of running that line. A test that drives a pattern through a flow
  without asserting anything still marks those lines covered.
- Handler bodies and derived expressions run only when a test drives them, and a
  pattern unit test can drive both. A JSX handler, inline or bound, compiles to a
  stream on the node's prop: a test walks the rendered tree to the node, reads
  the prop, and sends it an event. A derived expression such as `{count * 2}`
  runs when a test reads the node it builds. So UI raises the uncovered-line
  count only until a test drives it; write that test rather than taking a
  `NEW_PERF_BASELINE` marker.
  [pattern-testing.md](../common/workflows/pattern-testing.md) shows how.

`CF_PATTERN_COVERAGE_DIR` names the directory the `*.pattern-coverage.lcov`
files are written to. The `cf test` command in
`packages/cli/commands/test-command.ts` reads it directly. The browser
integration path does not run through `cf test`; there the integration harness
reads the same variable to decide whether to turn worker coverage on and where to
write the merged LCOV it pulls back from the browser (see "How the integration
jobs collect authored-pattern coverage").

## How the two feed the coverage gate

The Performance Check job downloads every `coverage-profile-*` artifact with
`actions/download-artifact`. The action checks each artifact's recorded digest.
`tasks/perf-check.ts` verifies that every expected artifact is present. It joins
all the downloaded LCOV files together and hands them to
`tasks/coverage-metrics.ts`. That code walks the tracked source files under
`packages` and `tasks`. For each file, it counts how many lines no test covered.
The top-level `scripts` directory is excluded from this gate. The counts roll up
into
`coverage-debt: <group> uncovered lines` metrics, for example
`coverage-debt: packages/patterns uncovered lines`, and the performance check
gates a pull request on them.

Authored pattern files under `packages/patterns` are tracked source files, so
their uncovered lines count toward `coverage-debt: packages/patterns`. Every
authored-pattern coverage stream feeds this one metric: the `pattern-unit-test`
job's coverage (`TN:pattern-runtime`) and the integration jobs' coverage
(`TN:pattern-runtime-integration`) both join the combined LCOV, and a line
covered by either counts covered. Nothing in the accounting reads the test name —
the two are kept distinct only so a reader of the combined report can tell what
covered a line.

One detail of the gate's accounting is worth knowing when reasoning about
pattern coverage. A file with no LCOV record has every tracked line counted as
uncovered. A file with a record is scored against the lines that record names.
For a file measured by Deno's V8 coverage that is every executable line; pattern
instrumentation names only the statements it could instrument, so a pattern
file's first record both covers real lines and drops the never-named lines out of
the count.

The gate absorbs that safely, because it is a ratchet: it fails a pull request
only when a group's uncovered count *rises* above the latest `main` baseline.
Gaining a record can only *lower* a file's count, since the record names a subset
of the file's lines and the rest stop being counted, so it settles at a lower —
and therefore stricter — bar rather than failing anything. The instrumented
statements are also the only lines this mechanism can speak to: a line the
instrumentation cannot reach is not a line a pattern test could cover.

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
| `pattern-integration-test` | yes | yes (browser worker collector) |
| `pattern-reload-integration-test` | yes | yes (browser worker collector) |

The pattern unit job runs each `packages/patterns/**/*.test.tsx` file through
`cf test` in-process. The two integration jobs run browser-driven `deno test`
files against a running Toolshed server. Both kinds of authored-pattern coverage
feed the same gated metric.

The compile byte cache is available to `cf test` through
`CF_COMPILE_CACHE_FILE`. Coverage and non-coverage compiles use different cache
keys. Coverage cache entries also carry the spans registered during the
transform, so a restored coverage compile can rebuild the current collector
before the cached module bytes run. The `pattern-unit-test` job wires both
`CF_PATTERN_COVERAGE_DIR` and `CF_COMPILE_CACHE_FILE`, which lets CI reuse
coverage-transformed module bytes between runs without mixing them with ordinary
compiled bytes.

The persistent cell cache stores each module's span list as one JSON string.
This keeps reporting metadata in one value instead of expanding every span
object into its own derived storage records. Coverage caches use the
`pattern-coverage` variant. The cell-cache reader accepts only the JSON string
representation. A covered closure without valid JSON spans is treated as a
cache miss, recompiled from source, and written back in the scalar format.

The runner remembers persisted closures for the lifetime of the runner session.
Each entry is identified by its space, cache variant, entry identity, and
complete module identity set. It skips another persistence operation for the
same closure. Concurrent requests for the same closure share one persistence
operation.

## How the integration jobs collect authored-pattern coverage

For these jobs coverage is a runtime-level capability rather than a `cf test`
one, so the worker never reads `CF_PATTERN_COVERAGE_DIR`. In an integration test
the pattern's event handlers run in the browser's runtime Web Worker, and that
worker is constructed with `RuntimeOptions.patternCoverage` on — a
`patternCoverage` flag on the worker's `InitializationData`, which the
integration harness sets when `CF_PATTERN_COVERAGE_DIR` is present. Every compile
the worker performs is then instrumented, including the piece-load path through
the content-addressed cell cache, whose instrumented variant is keyed apart from
the ordinary one so the worker never runs uninstrumented bytes.

Keying the variants apart means a piece an ordinary realm authored has no
instrumented closure to warm-load. That resume falls back to cold recovery — a
recompile from the stored source closure, which the runtime instruments like any
other compile — so the resumed piece reports coverage for the handlers it runs
rather than reporting nothing. The recovery writes its instrumented bodies back
under the coverage variant, so later coverage-on sessions warm-load them instead
of recompiling.

The cache-key split has a consequence for the test process too. In a
browser-driven test that process runs a pieces controller
(`initializePiecesController`) that creates the space's pieces. When the run
collects coverage, the controller has to collect it too — and this matters beyond
its own coverage.

Here is why. A coverage-on browser reads the instrumented cache variant. An
uninstrumented controller writes the ordinary one. So if the controller does not
instrument, every browser misses what the controller wrote and compiles each
pattern from scratch for itself. That includes the space-root default pattern,
which `ensureDefaultPattern` exists to compile exactly once. Each of those
compiles is synchronous, so it wedges the worker's event loop and stalls
unrelated IPC — the "second-boot slow window" the lunch-poll vote test describes.
With the controller uninstrumented, that test ran for 16 minutes and never
rendered its UI. Once it instruments, the test passes in 7 seconds.

A new browser-driven suite that creates its pieces some other way should expect
the same trap.

Getting the hits back out crosses two boundaries: the worker's and the browser's.
`PatternCoverageCollector.toData()` and `ingest()` give the spans and hit counts a
plain-JSON form. The worker exposes them over the RuntimeClient IPC
(`GetPatternCoverage`), and the harness pulls them with `page.evaluate` at
teardown — one batched dump per page, not a per-hit round trip. Every realm runs
the same instrumented bytes, so the fileName-plus-span-id keys line up: a realm
that only warm-loaded already-instrumented bytes reports hits that merge cleanly
against the realm that compiled them and holds the spans. The harness merges the
realms' hits and writes one `*.pattern-coverage.lcov` tagged
`TN:pattern-runtime-integration`, which the job uploads in its
`coverage-profile-*` artifact.

Integration coverage counts toward the gated `coverage-debt: packages/patterns`
metric exactly like unit coverage, which means a broad end-to-end flow that runs a
line without asserting on it lowers the debt. That trade is deliberate. Crediting
integration coverage only in a separate, never-gated number would score whatever
an end-to-end flow reaches — a piece assembled across several patterns, a path
through the shell no unit test drives — as uncovered however well it is
exercised. Coverage does not measure verification either way (see the properties
under "Authored pattern code is measured by transformer instrumentation"), so a
unit test that asserts on what it ran remains the better test; the gate just does
not treat what an integration test covers as worthless.

A span's file name is whatever the realm that compiled it called the module, and
that arrives in two shapes. A pattern the controller resolved off disk is named
relative to the patterns root (`/lunch-poll/main.tsx`), because that is the root
the resolver was given. A pattern the worker fetched over HTTP is named by its URL
pathname (`/api/patterns/system/default-app.tsx`), because Toolshed's pattern
identity is computed over pathname-prefixed names. Stripping the route prefix maps
the second shape onto the first, and both then resolve against the patterns root.

That rename runs when the report is written rather than as each realm reports,
because the realms do not all arrive the same way: the browser dumps are ingested,
but a runtime this process runs registers its spans into the shared collector
directly, as it compiles. Renaming on the way in silently covers only the first
kind. A record naming a file that is not in the checkout is the failure mode to
watch for — the gate matches records against the files it walked, so such a record
matches nothing and drops its coverage without complaining, which looks exactly
like a pattern nobody tested. Writing one warns.

## Known limitations and possible future work

- Only the browser-driven suites contribute. A pattern exercised solely through
  the headless multi-runtime harness (`multi-runtime-harness.ts`), whose sessions
  are Deno workers rather than pages, has nowhere for the teardown dump to run and
  contributes nothing. Those sessions could write their own LCOV directly — they
  are Deno realms with a filesystem — which is the natural way to extend this.

- Integration coverage is not a reason to skip a unit test. A unit test can cover
  a handler body too (see the handler bullet above) and can assert on what the
  handler did, which coverage never checks. Integration coverage only removes the
  case where a line no unit test happens to drive would otherwise read as
  untested.

## Related documentation

- [TESTING.md](TESTING.md) — how to run the test suites whose execution this
  coverage is measured from.
- [CI_PERFORMANCE.md](CI_PERFORMANCE.md) — the coverage-debt baseline and ratchet
  markers (`NEW_PERF_BASELINE` and `NEW_COVERAGE_BASELINE`) that gate a pull
  request on the metrics described here.
- [../common/workflows/pattern-testing.md](../common/workflows/pattern-testing.md)
  — writing the pattern unit tests that the `pattern-unit-test` job runs through
  `cf test`, the source of the gated authored-pattern coverage.
