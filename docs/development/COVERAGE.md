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
  count only until a test drives it; write that test rather than taking an
  `ACCEPT_COVERAGE_DEBT` marker.
  [pattern-testing.md](../common/workflows/pattern-testing.md) shows how.

`CF_PATTERN_COVERAGE_DIR` names the directory the `*.pattern-coverage.lcov`
files are written to. The `cf test` command in
`packages/cli/commands/test-command.ts` reads it directly. The browser
integration path does not run through `cf test`; there the integration harness
reads the same variable to decide whether to turn worker coverage on and where to
write the merged LCOV it pulls back from the browser (see "How the integration
jobs collect authored-pattern coverage").

## How the two feed the coverage gate

The Coverage Check job downloads every `coverage-profile-*` artifact with
`actions/download-artifact`. The action checks each artifact's recorded digest.
`tasks/coverage-check.ts` verifies that every expected artifact is present. It
joins all the downloaded LCOV files together and hands them to
`tasks/coverage-metrics.ts`. That code walks the tracked source files under
`packages` and `tasks`. For each file, it counts how many lines no test covered.
The top-level `scripts` directory is excluded from this gate. The counts roll up
into
`coverage-debt: <group> uncovered lines` metrics, for example
`coverage-debt: packages/patterns uncovered lines`, and the coverage check
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
uncovered, unless it compiles to no code at all — see the next subsection. A
file with a record is scored against the lines that record names.
For a file measured by Deno's V8 coverage that is every executable line; pattern
instrumentation names only the statements it could instrument, so a pattern
file's first record both covers real lines and drops the never-named lines out of
the count.

The gate absorbs that safely, because it is a ratchet: it fails a pull request
only when a group's uncovered count *rises* above its `main` baseline.
Gaining a record can only *lower* a file's count, since the record names a subset
of the file's lines and the rest stop being counted, so it settles at a lower —
and therefore stricter — bar rather than failing anything. The instrumented
statements are also the only lines this mechanism can speak to: a line the
instrumentation cannot reach is not a line a pattern test could cover.

### A file that compiles to nothing is charged nothing

Charging every tracked line of a file with no coverage record is how the gate
catches source that no test ever loaded. A second kind of file also has no
record: one holding only declarations — interfaces, type aliases, ambient
declarations — which compiles to an empty module. Such a file has no statement
to run, so a test that loads it executes nothing and Deno's coverage has nothing
to report. No test can cover a line of it, so the gate charges it nothing.

The gate tells the two apart by compiling each file it finds no record for, and
charges it only when something comes out. `tasks/executable-source.ts` runs the
file through the TypeScript compiler and reads the emitted JavaScript: a file
that emits no statement, an `export {}` module marker aside, is charged nothing,
and every other file is charged its full tracked-line count. Which constructs
reach the output is the compiler's rule. An enum, a namespace holding a value,
and an import kept for its side effects all emit code. A type-only import, a
namespace holding only types, and a comment do not. The compile happens at gate
time, once per file the report leaves out. A file with a record never pays for
it, because its record already says which of its lines ran.

Such a file occasionally does get a record. A comment that survives into the
emitted output leaves Deno one line to report, and that line is hit the moment
the module loads, so the file contributes nothing either way.

The charge is all or nothing. The first line of runnable code added to such a
file charges the whole file, which is the bill a new module of that size runs
up. A file that gains code usually gains a coverage record with it, and that
brings the charge down to the lines no test reached. The full charge stands
only while nothing loads the file.

## Coverage must not depend on the execution environment

Whether a line counts as covered must not depend on how fast the machine ran,
how the test files were distributed across shards, or any other property of the
environment or configuration. A line that is covered on one run and uncovered
on the next is a defect in the tests. It is not noise for the gate to absorb,
and it is not something to wave through with an override.

So when you find a line whose coverage moves with the environment — a branch
guarded on elapsed wall-clock time, a line whose count changes when test files
are redistributed across shards, a path that only some runs happen to take —
write a test that covers that line reliably on every run and under every
configuration. Extract the code into something a plain unit test can call
directly if that is what it takes: a unit test that constructs the input it
wants does not care how loaded the machine is or which shard it landed in.

The
[2026-07-28 investigation record](../history/development/coverage-ratchet-noise-2026-07-28.md)
works through two real instances, and describes how to localize a group-level
change down to the specific file and line so you know what to write a test for.

### Diagnostics that fire on wall-clock time

The slow-traverse report in `packages/runner/src/traverse.ts` was one of those
instances. It logged a traversal's counters only when that traversal had taken
more than 100 milliseconds of real time, so it ran on a loaded machine and did
not run on an idle one. Thirty-nine lines moved with the load: the body of the
report, plus the two `MapSet` getters that nothing but the report called.
Several unrelated pull requests spent an `ACCEPT_COVERAGE_DEBT` marker on the
result.

Write such a diagnostic so that the elapsed time reaches it as a parameter,
rather than having the reporting code measure the time for itself. Put the
threshold comparison and the report together in a function that takes the
elapsed time, and call that function from the timed path every time, with no
condition around the call. That is what `maybeReportSlowTraverse()` does now.
Every line of the diagnostic then runs on every machine, and the clock decides
nothing except which way the comparison inside goes.

A test reaches the report by choosing the elapsed time. It can call the
function directly with a time over the threshold, or it can pin the clock the
timed path reads, which also proves that the path still reaches the
diagnostic. The `SchemaObjectTraverser slow-traverse reporting` cases in
`packages/runner/test/traverse.test.ts` are the worked example of the second.
They replace `performance.now` — what `logger.timeStart` and `timeEnd` read —
for the length of one traversal, and advance it from a store read, because
`traverse()` is synchronous and a test cannot step a clock from outside a call
that never yields. That the traversal really did read the store is asserted, so
a traversal that stopped reading could not pass the test vacuously.

The fake clock that a package's test task preloads does not cover a branch like
this one, and cannot. It replaces `performance.now` with logical time, and
logical time moves only when a positive-delay timer fires. A synchronous call
arms no timers, so a span timed around synchronous work measures exactly zero:
under the runner package's preload, `elapsed > 100` is deterministically false
in every test in the package. The `clock.tick(ms)` control is asynchronous and
advances nothing until it is awaited, so there is no way to move logical time
from inside a synchronous call either. A test that wants a chosen elapsed time
therefore replaces `performance.now` outright, saving and restoring it rather
than assuming it is the native one, since the preload already owns that
property. That is also why the movement was collected by the
pattern-integration jobs rather than by the runner suite: their coverage comes
from a browser worker, which a Deno `--preload` never reaches.

Leaving the threshold comparison behind at the call site does not reduce the
movement to nothing. The lines inside a guard are covered only on a run that
took the branch, so a call site of the form
`if (elapsed > SLOW_TRAVERSE_MS) report(...)` keeps its reporting line moving
from one run to the next, and one line of movement fails the ratchet exactly as
thirty-nine did. Do not reason from what the `if` line itself reports either.
That count is a projection of V8's block ranges onto lines: it differs between
the one-line and the braced form of the same guard, and it changed between deno
2.8.3 and the pinned 2.9.4, which now credits a braced guard's line with the
condition's own count. See
[deno coverage: one-line guard reported uncovered when its branch is not taken](deno-coverage-guard-line-artifact.md).

## Ratchet baselines and accepting debt

The ratchet applies per source group and only to the groups a PR changes: for
each such group the uncovered-line count must not rise above the count from the
`main` run for the base-branch commit the PR is merged with, or the nearest
ancestor of it that has one (see "Which `main` run the ratchet compares
against"). Debt in unchanged groups is still reported, but does not block the
PR.

Accept one metric's increase with the narrow per-metric marker in the PR
description:

```text
ACCEPT_COVERAGE_DEBT: coverage-debt: packages/runner uncovered lines = 123 lines
```

Use the broad reset marker only to bootstrap coverage data for the first time,
or when the `main` baseline is known to be bogus and should be re-seeded for one
cycle:

```text
NEW_COVERAGE_BASELINE
```

When that PR merges, the main run's coverage metrics become the new ratchet
baseline for later PRs. The check still requires the full expected coverage
artifact set during that reset cycle. Jobs with no reportable covered files
upload an empty LCOV report, so a missing artifact means the report upload
itself failed.

Each run writes a per-run baseline artifact recording its coverage-debt metrics
and its compile cache states. It is named `perf-metrics` for historical reasons
— it once also carried CI timing metrics for the removed performance gate — and
keeps that name so the ratchet needs no migration; a run from before the gate
was removed reads as a valid baseline unchanged. A later PR run reads its ratchet
baseline from the `perf-metrics` artifact of the `main` run for the base-branch
commit it merged, or of the nearest ancestor of that commit which has one; there
is no separate history store. The workflow downloads the current run's
`coverage-profile-*` artifacts before starting `tasks/coverage-check.ts`.
`COVERAGE_ARTIFACTS_DIR` points the script at one subdirectory per artifact. The
download step checks the artifact digests. The script separately checks the
expected artifact names (`EXPECTED_COVERAGE_ARTIFACT_NAMES`). It also rejects an
artifact containing no coverage files. A manual run without the environment
variable uses the GitHub API download path instead.

## Compile cache state and cold runs

The pattern test jobs restore a compile byte cache keyed on a fingerprint hash
over the compiler packages. A PR that changes that fingerprint runs cold: every
pattern compiles from scratch. A cold run covers compile branches that only
execute on a cold cache, which lowers its coverage debt, so ratcheting a warm PR
against a cold `main` run would fail it with phantom uncovered lines.

The pattern-integration process owns one shared cache in
`packages/patterns/integration/pieces-controller.ts`. Its controller helper and
the capability-gate controller both inject that cache into every runtime they
create. A custom runtime in this suite must do the same. Setting
`CF_COMPILE_CACHE_FILE` only tells the test-support cache where to persist its
bytes; a runtime uses those bytes only when it receives the cache through its
`moduleByteCache` option.

To tell cold from warm, each pattern job uploads a small `cache-state-*`
artifact recording its cache restore result. The coverage check aggregates those
into `compileCacheStates` in `perf-metrics.json`. A job family is cold when
any of its shards had a full cache miss, detected as the cache file being absent
after the restore step (the combined `actions/cache` action does not expose the
matched key). A partial hit through a restore key counts as warm: both key forms
start with the fingerprint hash, so any restore means the compiled bytes are
current. The ratchet skips a cold sample when choosing among the
base-branch commit and its ancestors, so a cold `main` run cannot lower the
baseline that warm PRs are held to.

A run without a recorded cache state — an artifact carrying no stamp, or a run
whose cache-state artifact failed to upload — is retro-classified from the
compile fingerprint (`tasks/compile-cache-state.ts` mirrors the `cc-*` key globs,
drift-guarded by a test that parses the workflow): if the fingerprint paths
changed against the run's predecessor, every family is treated as cold; if
unchanged, warm. The same fingerprint inference backstops the current run when
its cache-state artifact is missing. Fingerprint inference cannot see
non-fingerprint cold causes (cache eviction, cache-service outages): a run cold
for those reasons and lacking a recorded state stays unknown, so it is treated
as not-cold and may still be used as a baseline.

## Which `main` run the ratchet compares against

A `pull_request` run checks out `refs/pull/<number>/merge`, whose first parent
is the base-branch commit and whose second parent is the pull request head.
GitHub rebuilds that merge ref whenever the base branch moves, so the run
measures the pull request merged with `main` as it stood when the run started.

The baseline is the `main` run for that commit, or for the nearest ancestor of
it that has one. Comparing against the commit itself is exact: both numbers
count the same base-branch code, so the only difference between them is the
pull request. Runs that are not ancestors are never used, in either direction —
one that landed after the run started measured code the run does not contain.

The base commit's own run is usually available, but not always: it may still be
going, or it may have failed. Rather than skip the gate, the ratchet steps back
to the nearest ancestor that has a usable run. Whatever the base branch changed
in between is then present in this run and absent from the baseline, so the
groups it touched have totals that count different code on the two sides. Those
groups are reported and not gated; every other group still is, which is the
point of stepping back rather than giving up. A gap of one or two commits
usually touches one or two groups.

One case this does not reach: a base-branch commit that changes a test in one
package can move the coverage of source in another, and no diff of that source
names it. It ends when a `main` run measures the base commit.

Two details of reading the base commit are load-bearing. It comes from the
checked-out merge commit rather than the triggering event, because GitHub does
not rewrite `pull_request.base.sha` when it rebuilds the merge ref. And it is
read with `git cat-file commit HEAD` rather than `git log --format=%P`, because
`actions/checkout` clones to depth one and git reports a shallow boundary commit
as having no parents.

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
- [CI_PERFORMANCE.md](CI_PERFORMANCE.md) — CI wall-time optimization policy.
- [One-line guard coverage artifact](deno-coverage-guard-line-artifact.md) —
  why V8 can report a one-line conditional guard as uncovered when its branch
  is not taken.
- [../common/workflows/pattern-testing.md](../common/workflows/pattern-testing.md)
  — writing the pattern unit tests that the `pattern-unit-test` job runs through
  `cf test`, the source of the gated authored-pattern coverage.
