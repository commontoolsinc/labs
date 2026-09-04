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

A focused `*.browser.test.ts` file run through `deno-web-test` executes its
application module inside Chrome. That browser execution proves DOM behavior,
but it does not enter the Deno V8 profile. Put reusable policy and state
transitions in an ordinary source module and exercise them from a plain Deno
unit test as well; keep the browser case for the boundary only a real DOM can
prove.

Do not name a source file so that its path ends in `test.ts` (or `test.tsx`,
`test.js`, `test.mjs`, `test.jsx`). `deno coverage` takes those for test files
and leaves them out of the report, even though V8 records them and even if
`--exclude` is overridden. The debt metric reads a missing report entry as a
file no test ever loaded and charges every one of its lines, so a well-tested
file scores as entirely uncovered. This is why the `cf test` command lives in
`commands/test-command.ts`.

#### A file can also drop out of the report on its own

`deno coverage` builds the report from each covered file's transpiled form in
the Deno cache rather than from the source on disk. A file whose transpiled form
is absent from the cache is left out of the report, with a warning on stderr and
no change to the exit status. Because the debt metric charges every line of a
file that has no report entry, such a drop reads downstream as a coverage
regression that no change in the tree explains.

`deno coverage` says which of two things happened, in two different messages,
and `tasks/write-coverage-lcov.ts` acts on the difference:

- `Missing transpiled source code for: "<url>"` — the source is on disk but the
  cache holds no transpiled form of it. For a file the debt metric tracks that is
  a file the report should have carried: the script names those files and exits
  non-zero, after writing the report of what did convert so it can be read while
  the cause is found. Three things cause it. The profiles were collected by one
  Deno version and reported by another, which happens when a test starts the Deno
  on `PATH` instead of the Deno running it. Or they were collected from a working
  directory under a different Deno configuration, because the cache key covers
  the configuration in scope where the file was compiled. Or the run that
  collected them could not write the cache at all, which is what an agent
  sandbox that denies writes to `DENO_DIR` produces: the tests pass, because
  the transpiled form is held in memory, and every file is then missing from
  the report, so `deno coverage` says the profile covered nothing rather than
  naming the denial. Collect coverage outside the sandbox.
- `Source not found for "<url>"` — the source is gone, so a test compiled the
  file and then deleted it. No report could name it, so the script warns and
  carries on.

A file the metric does not track is only ever warned about, whichever message it
came with, because its absence from the report costs nothing. The conversion asks
the metric's own `isTrackedSourcePath`, so the two cannot drift apart. That
covers a file outside the repository, which is what a test that copies a fixture
project into a temporary directory and runs Deno there produces, as well as one
inside it that the metric never charges for — anything under `docs/` or
`scripts/`, a test or fixture directory, a `.test.ts` or `.d.ts`.

An empty report is not a failure by itself. `deno coverage` calls it an error
when nothing survives its filters, which happens honestly whenever a profile set
covers only test files, since those are excluded by design. With no repository
file dropped, the script takes that emptiness at face value: it warns and exits
zero. It also warns and exits zero when there was nothing to convert in the first
place, which is what a job whose test step never ran produces — the profile
directory is absent, or holds only empty files. Any other `deno coverage` failure
is an error.

Every one of those paths writes an output file, so the artifact upload always has
one to collect and the outcome is read from the conversion step rather than from
a missing file.

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

#### What a pattern test has to read

The last bullet generalizes past handlers and derived expressions. Almost every
line of a pattern outside a handler body runs when something reads the value the
pattern returns, and a pattern test that drives streams and compares scalars
reads hardly any of it. Three groups go uncovered that way, and one pattern test
can take all three.

The view is the first. A pattern's view helpers are ordinary functions, and
nothing calls one until something reads `[UI]`. Reaching for a node is what
builds the tree, so one assertion that walks to a node covers every helper the
tree called on the way there. `packages/patterns/test/vnode-helpers.ts` holds
the walk. Tie the assertion to something the file already claims rather than to
a node's bare existence:
`hasText(findNodeById(instance[UI], "gallery-count"), "16 total examples")`
states the rendered header against the count the same test asserts through
`totalExamples`, so a gallery that computed its count and rendered nothing
fails.

The returned record is the second. A `computed()` sitting in it runs when a
reader asks for that field, so `[NAME]` and any output the test never compares
against goes unrun. State those against the values the test's own actions put
there, which says the setter stream reached the cell the field reports.

A stream nobody sends to is the third. A handler the pattern exposes and no test
drives has a body that runs in neither lane, so it sits at zero on every run
rather than moving between them. That is permanent debt rather than flap, and it
costs one more action apiece to clear.

`packages/patterns/cfc-spec-gallery/main.test.tsx` is the worked example. It
reads its view, states its name and the four inputs it reports back out, and
drives every stream the gallery exposes, which takes the file from 385 of its
522 measured lines to all of them. Before that the integration lane was the only
one covering the other 137, and
[the investigation record](../history/development/coverage-flake-cfc-spec-gallery-view-2026-09-01.md)
is what that cost the group on a run where the lane's report went missing.

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

### A file that opts out of coverage is charged nothing

A `// deno-coverage-ignore-file` comment on a file's first line, or on the line
after its shebang, opts the file out of Deno's coverage: `deno coverage` leaves
it out of the report it writes, whether or not a test loaded it. The gate reads
the same line for a file the report has no record for, and charges such a file
nothing, so the comment means the same thing on a file no test can load as on
one a test did.

Those are the only lines Deno reads it from, ahead of every other comment and
pragma; the same comment anywhere later leaves the file in Deno's report and
charged by the gate. A `// @ts-check` or a `deno-lint-ignore-file` goes on the
line after it. Text may follow the directive after whitespace, which is the
place for the reason:

```text
// deno-coverage-ignore-file -- runs only in a browser, as inlined text
```

The comment is for a file Deno's coverage cannot measure. A notable case is a
source file that runs only in a browser, such as one imported as text and
inlined into a document a frame loads: no Deno-run test can load it, so no
test could pay its debt down, and the browser tests that do drive it report
into nothing this metric reads. A file a Deno test could load is not such a
file, and the ratchet is what holds it to its tests.

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

Before localizing, check that the group-level change is a measurement at all. A
group marked `excl` in the job's table under the line "Not gated, because no
baseline counts the same base-branch code as this run does" is comparing two
different bodies of code, because the ratchet stepped back to an older baseline
commit; its `Change` column then reports what the base branch did in between.
Comparing two runs directly has the same trap in a different form, since a
pull request's runs measure the merge ref, which GitHub rebuilds whenever the
base branch moves. Compare only files whose content is identical between the
two commits, and read the counts per line rather than per group.

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

### Paths reached only when something happens twice

A second common shape is a line that runs only on the second occurrence of
something within one process: a cache that is populated the second time it is
asked, a guard that turns away a duplicate, a retry that only a second failure
reaches. Whether a suite produces that second occurrence is often decided by
scheduling rather than by anything a test asserts, so the line is covered on
some runs and not on others.

Write a test that produces the second occurrence itself rather than one that
performs an operation and hopes the suite repeats it. The
`records one violation for an action caught twice` case in
`packages/runner/test/scheduler-pull-idempotency.test.ts` is the worked
example. It reaches the deduplication guard in `runIdempotencyRecheck()` by
running one action twice over an input it moves, and it distinguishes a
deduplicated second detection from a single detection by having the action
write an incrementing count, so the recorded violation says which detection it
came from.

An assertion that only counts the outcome would pass either way and would leave
the line's coverage exactly as environment-dependent as it was.
[The August 2026 record](../history/development/coverage-flake-idempotency-dedup-2026-08-12.md)
follows one such line from a group-level `+2` down to the guard and the test.

### Rejection paths reached only when two writes race

The third shape is a branch that runs only when one write lands on a base
another write already changed: a merge that finds the key it removes already
gone, a precondition only a loser fails, a replay that has to drop a layer. The
surrounding code runs constantly. What decides whether the branch runs is the
order frames arrive in, which nothing in an integration suite asserts, so the
line is covered on some runs and not on others.

Reaching such a line does not take a race, and that is the way out of it. What
the branch responds to is the value the operation was handed, so a test that
constructs that value reaches the branch directly. `applyPatch()` is a pure
function over a value tree: its `missing object key` rejection, which the
client's pending-layer replay reaches when a `remove` names a key a winning
writer already dropped, is one call over a base object without the key.
`packages/memory/test/v2-patch-errors.test.ts` is the worked example, and it
states one case per rejection the module raises rather than only the line that
moved — a sibling branch in the same file is the next one to flap.
[The investigation record](../history/development/coverage-flake-patch-remove-missing-key-2026-08-17.md)
follows that line from a group-level `+2` down to the two integration hits that
covered it in one run and not the next.

What the second party holds need not be a write. A lease row another process
owns puts a branch in the same position: the server executor's `activate()`
reports `lease-unavailable` and returns `false` only when the space's execution
lease is already held, and the host arm that unregisters the refused space runs
only behind that. Nothing in the suite asks for a rival holder, so both were
reached when one case's park happened to chain a re-activation while the rival
row it had installed for a different purpose still stood. The way out is the
same one: a lease is a row, so a test writes the row and calls `activate()`. The
cases are in `packages/runner/test/executor-space-server.test.ts` and
`packages/runner/test/executor-serving-loop.test.ts`, and
[their investigation record](../history/development/coverage-flake-executor-contention-paths-2026-08-26.md)
follows ten lines across three files from a group-level `+10` down to the two
shards that reached them.

### Failure reports reached only when the operation fails

A fourth shape is the branch that reports a failure: the `if (error)` arm of an
asynchronous recovery, the log line that says a write was refused. The recovery
around it runs on every resume, and the report inside it runs only when the
write underneath fails. No test asks for that write to fail, so whether the line
is covered comes down to whether some suite, somewhere in the run, happened to
tear a runtime down while one was in flight.

The list coordinators' resume-seed recovery was one of those. A coordinator
resuming against a result container with no durable value pulls the container
and seeds an empty array once the pull settles, and it warns when either the
pull or the seed fails. One workspace shard on one `main` run reached the seed's
warning three times; no other artifact in that run or the next reached it at
all.

Reaching such a branch takes a failing operation, not a failing environment, so
give the recovery its operation as a parameter.
`seedResultContainerWhenPullSettles()` in
`packages/runner/src/builtins/list-result-container-seed.ts` takes the runtime,
the container, a predicate saying whether the coordinator still holds it, the
pull to wait on, and the logger to report through.
`packages/runner/test/list-result-container-seed.test.ts` then hands it a pull
that rejects and a runtime whose commits are refused. Each failure case asserts
the message key and the error carried with it, so a report that changed which
failure it named fails rather than staying green on the line count.

A guard reached only on a retry takes the same treatment. `editWithRetry()`
runs its action synchronously on the first attempt, so a liveness check inside
the action reads as unable to disagree with the one the caller just made — and
as a dead line. It is not: a retryable rejection is followed by an `await` of
the conflict's catch-up gate and then a fresh call that runs the action again.
A test reaches it by refusing the first commit with a `ConflictError` whose
`readyToRetry` gate flips the liveness answer, and asserts the commit count so
that a version which stopped retrying fails rather than passing vacuously.

Extracting it also settled where the branch lives. The same recovery had been
written out three times, once each in `map.ts`, `filter.ts` and `flatmap.ts`, so
one failure report was three separate branches waiting to flap, and two of them
had never been covered on any run.
[The investigation record](../history/development/coverage-flake-list-resume-seed-2026-08-20.md)
follows the five lines from the group-level `+3` down to the single artifact
that covered them.

The fetch builtins' completion writeback is the same shape with nothing to
extract. `tryWriteResult()` already takes the runtime it commits through, and
so does `startFetch()`, so a test that hands either one a runtime whose commits
are refused reaches both the arm that carries the refusal back and the throw
that converts it. `packages/runner/test/fetch-writeback.test.ts` states the
function's three outcomes, because the two that do not write are distinct for
the caller — inputs that moved mean the request was superseded and is done,
while a refused commit means the claim is still pending and only this response
could have completed it — and then drives `fetchJson` end to end against a held
response with the writeback's commit refused.

Refusing ONE commit inside a real run takes a way to say which one, and
position is the wrong way to say it: what sits between the response and the
writeback is scheduling, which is the thing being taken out of the answer.
Name the transaction by what it writes instead. The completion writeback is the
transaction that carries the response into the builtin's result document, which
`getTransactionWriteAttempts()` reports at commit time; the error writeback that
follows it only clears a result that is already absent, which records no write
of that document at all. Asking for the one commit that writes it therefore
lands the refusal on the completion write and on nothing else, however the run
is scheduled. A case that wants both refused names a document both of them do
write — the claim they each release — rather than refusing every commit from
the response onward, which would count whatever else the scheduler opened in
the same window. Count the transactions the name matched, past the number
refused rather than capped at it, and state that count: a run that produced
another matching transaction then fails on the count instead of quietly leaving
it to commit.
[The investigation record](../history/development/coverage-flake-fetch-writeback-refusal-2026-08-24.md)
follows those five lines from the group-level `+5` down to the single artifact
that covered them, and to the sibling rethrow that no artifact in either run
covered.

### Branches reached only when a batch carries unrelated work

A fifth shape is the branch that handles what a failure did not touch: the
skip for the entry a bulk operation leaves alone, the arm that keeps the
survivors of a partial failure moving. Whether the branch runs is decided by
what else was in the batch when the failure landed, and that is assembled by
scheduling rather than named by any test.

The server executor's wave withdrawal is one of those. When a foreign space's
co-hosted engine cannot be resolved, `commitWave()` in
`packages/runner/src/executor/wave.ts` walks the wave's contributions and
withdraws the ones that sealed into that space — an event handler requeues, a
derivation drops — while everything else commits. Reaching the skip that lets
everything else through takes a wave holding both a contribution that crossed
into the failed space and one that did not. An end-to-end test can provoke the
first; the second is whatever the serving loop had sealed by then. The loop was
entered by exactly one artifact in each of two consecutive runs, and it saw two
contributions on one and one on the other.

Assemble the batch in the test rather than provoking one. `WaveAccumulator`
takes its space, lease and replica lookup as arguments and exposes
`failForeignSpace()` as a method, so a test seals the contributions it wants,
fails a space, and commits, with nothing else deciding what the wave holds. The
`an unresolvable foreign space withdraws exactly its own crossings` case in
`packages/runner/test/executor-wave.test.ts` puts one contribution of each kind
in the wave and asserts the disposition of each, so a version that withdrew the
bystander with the crossings fails rather than staying green on the line count.
State all the arms in the one case rather than only the arm that moved. The
derivation drop arm beside this flapping skip had never been covered on any
run, and it comes for free once the wave is built by hand — whereas a case
written for the skip alone leaves it exactly where it was, and a second case
added for it later would set up the same wave twice.
[The investigation record](../history/development/coverage-flake-foreign-space-withdrawal-2026-08-26.md)
follows the single line from the group-level `+1` down to the one artifact that
covered it, and to the two arms neither run reached.

### Checks the layer below already makes

Not every line that moves deserves a test. Sometimes a line decides nothing:
every observable consequence is the same whether it is there or not, because
the code it calls makes the same check on its own. Opening a remote memory
session had three abort checks, one before connecting, one after connecting,
and one after mounting. The memory client refuses an aborted signal on entry to
both the connect and the mount, raising the signal's own reason, which the
caller's own catch clause converts exactly as its own check would. Only the
third check decides anything: an abort landing after the mount resolves has
already shut the client, and without the check the method would hand that dead
client back.

A test cannot distinguish such a line, which is exactly what makes it a
problem: any test written for it passes with the line deleted, so it protects
nothing and satisfies the tool. Delete the line instead, and write the test
that states what the surviving code does at that point. That test is what makes
the deletion safe — the check now lives one layer down, and the test fails if
that layer stops making it.

Reachability is not the test here. Both removed checks were reached in CI, on
the runs where an abort happened to land in the microtask between one library
call returning and the next line running. What decides the question is whether
any input tells the two versions apart.

### A branch only some of the corpus reaches

`packages/ts-transformers` and `packages/schema-generator` move for a reason of
their own: their unit suites never reach parts of the analyzer and the
formatters. What reaches them is the pattern integration jobs, compiling
whatever the pattern corpus happens to contain, on whichever shard the pattern
landed on. So a branch for a language construct the corpus uses rarely — a
`Stream<T>` parameter, a numeric literal type node, the bare `object` type —
is covered when a shard happened to compile the one pattern that spells it,
and uncovered otherwise. The carrier artifact names a different shard from one
run to the next for the same line.

These take a unit test, not a pattern. Both packages have `*-flap-coverage`
test files that build the type or the source they need and call the analyzer or
the generator directly:
`packages/ts-transformers/test/policy/capability-analysis-flap-coverage.test.ts`
and `packages/schema-generator/test/schema-generator-flap-coverage.test.ts`.
Each case asserts what the branch produces — that a stream argument is
recorded opaque while a writable argument is recorded read and written, that a
numeric literal emits a number rather than the string the node carries — so a
branch that changed what it produced would fail rather than stay green on the
line count.

### A fact the checkout supplies

A line can also sit behind a fact the code reads from the machine it is
running on: the branch the checkout is on, the platform, whether some tool is
installed. `tasks/test-records.ts` stamps a local test run with the branch,
and records one only when git names one. Continuous integration builds a pull
request from a detached merge commit, where `git branch --show-current` prints
nothing, so the arm that records a branch ran on a developer's machine and not
in that job. Its coverage then came from whatever else in the run happened to
build a context, which is what made it move.

A test that creates a scratch repository on a named branch does reach the arm,
and asserting that git's answer reaches the context is worth doing. It does
not settle the coverage, though, because it buys the line with a subprocess:
the line is covered where git is installed, behaves as the test expects, and
is allowed to run, and not elsewhere.

Separate reading the facts from deciding what they mean.
`buildLocalContext()` asks git for the commit, the branch and the status, and
hands the three answers to `composeLocalContext()`, which turns them into the
context. Reaching the arm that records a branch is then a matter of saying
what git said, so a unit test states the facts and asserts the context they
compose into. `tasks/test-records-flap-coverage.test.ts` holds one case per
arm: a branch git named, the empty string a detached checkout produces, and
the absent answer a directory outside a repository produces. Nothing in that
file runs a subprocess or reads the surrounding checkout, so every arm runs on
every machine.

### What the check says when the regression is not the pull request's

The gate compares whole-group counts, so a flapping line fails whichever pull
request is measured against a run that happened to cover it, however unrelated
the diff. The check recognizes that case and says so: when a gated group is over
its baseline and none of the lines the pull request added are uncovered, it
reads the coverage reports of the `main` run its baseline came from and names
every line this run leaves uncovered that the baseline run covered.

The comment lists those lines file by file, gives the `ACCEPT_COVERAGE_DEBT`
line that lets the pull request through, and carries a prompt for a fresh agent
session to make the lines cover the same way every time. The author's pull
request is not the place to fix them, and it is not held up waiting for someone
to.

The prompt says where the measurement came from, so a session picking it up can
locate it instead of reconstructing it: the page of the workflow run that
measured the lines, the base-branch commit that run merged the pull request
into, and — for each affected group — the baseline run its count was held
against and the commit that run measured. The commit named for the measuring
run is the base-branch commit rather than the pull request head, because a
`pull_request` run measures `refs/pull/<number>/merge`, and because the
question the reader has is what has landed on `main` since. The prompt hands
them the command that answers it, `git log <base commit>.. -- <file>`, and
tells them to say so and stop if a line has since changed or been given a test.

Anything the run context does not name is left out rather than guessed at. A
run of the checker outside GitHub Actions names no run page and no commit, and
its prompt falls back to asking the reader to check what has landed since the
measurement was taken.

The identity travels on the rows the gate builds. Each row already records the
baseline it was held against; it also records the run that measured it and the
base-branch commit that run merged, both of which the check has in hand when it
scores the row. The comment reads them back out of the rows it is given.

Only files the pull request left alone are compared. A file it changed has
different content in the two checkouts, so the same line number means a
different line in each report and no comparison is possible. When the baseline
run's coverage artifacts cannot be read — expired, or the download failed — the
check falls back to the ordinary regression comment.

## Ratchet baselines and accepting debt

The ratchet applies per source group and only to the groups a PR changes: for
each such group the uncovered-line count must not rise above the count from the
`main` run for the base-branch commit the PR is merged with, or the nearest
ancestor of it that has one (see "Which `main` run the ratchet compares
against"). Debt in unchanged groups is still reported, but does not block the
PR.

Accept one group's increase with the narrow per-group marker in the PR
description, on a line of its own and flush against the left margin:

```text
ACCEPT_COVERAGE_DEBT: packages/runner +12 lines
```

The marker names the source group — `workspace`, a top-level directory such as
`tasks`, or a package as `packages/runner` — rather than the metric that group's
lines are counted in. Only `packages` splits into a second level, because that is
where the collection stops rolling a file up; `tasks/foo` names no group.

A name can have the shape of a group and still name none — a package that is not
there, or a misspelling of one that is. Nothing would ever consult such a line,
so rather than let it pass for an acceptance that had no effect, the check fails
the job and lists the groups the run did measure.

The number is how far above the baseline the group may rise, not the total it
may reach. The gate passes the group when its uncovered-line count is at most
the baseline plus that number, so a run whose baseline is 5746 accepts 5758 and
fails at 5759. A group with no baseline yet is held to zero, and the whole of
the accepted rise is available to it.

Stating the rise is what makes the marker survive a rebase. The baseline the
ratchet compares against is the `main` run for whatever base-branch commit the
pull request is merged with, so it moves whenever the pull request is rebased. A
total written for one baseline says something different against the next one:
too generous when the base branch covered lines in the meantime, and short by the
difference when it uncovered some, which fails the pull request for debt it did
not add. A rise says the same thing against every baseline, so the marker keeps
accepting exactly the debt its author accepted and no more.

The check prints the line to paste, with the rise it measured already filled in,
under `---BEGIN COPY-PASTE---` at the end of the Coverage Check job's log. A line
that starts with `ACCEPT_COVERAGE_DEBT:` and that the check cannot read fails the
job and says what form to write instead, rather than being passed over as though
it were not there.

An accepted group keeps its attribution. The gate keeps one comment on the pull
request and rewrites it in place as the answer changes, and the comment an
acceptance leaves behind names the files holding the lines it accepted, under
"Files with new uncovered lines" — the same heading and the same counts the
failing run wrote. So the pull request goes on saying which file the debt is in
after the acceptance stops anything from failing over it.

The left margin is what tells an acceptance from a mention of one. A description
can name the marker in a sentence, and can indent an example of it into a code
block, without either being read as accepting anything — or as a malformed
attempt at it. Indent the line to show the form, and write it flush to use it. A
pull request description often starts life as a commit message body, so a line
indented there arrives indented, and stays an example. The check names each
indented marker it passed over in its log, so an author who indented one meaning
it as an acceptance can see why the gate carried on without it.

Use the broad reset marker only to bootstrap coverage data for the first time,
or when the `main` baseline is known to be bogus and should be re-seeded for one
cycle:

```text
NEW_COVERAGE_BASELINE
```

When that PR merges, the main run's coverage metrics become the new ratchet
baseline for later PRs, and no run before it is one: the accepted level is what
later runs are held to, and nothing older can undo it. That floor applies to the
metrics the acceptance named, or to every coverage metric for the broad reset
marker. It reaches only the PRs whose base-branch commit already contains the
acceptance; a PR whose run started earlier is gated against the ancestry it does
contain, and picks the floor up when a later run of it merges the acceptance. The
check still requires the full expected coverage artifact set during that reset
cycle. Jobs with no reportable covered files upload an empty LCOV report, so a
missing artifact means the report upload itself failed.

Each run writes a per-run baseline artifact recording its coverage-debt metrics
and its compile cache states. It is named `perf-metrics` for historical reasons
— it once also carried CI timing metrics for the removed performance gate — and
keeps that name so the ratchet needs no migration; a run from before the gate
was removed reads as a valid baseline unchanged. The file records each metric's
uncovered-line count under a `durationSeconds` key, for the same reason the
artifact keeps its name.

That artifact is also where the repository's coverage debt over time is read
from. The dashboard's coverage debt tile
(`packages/dashboard/coverage-debt-history.ts`) reads the
`coverage-debt: workspace uncovered lines` record out of one `main` run a day,
shows the newest of those figures, and charts the run of them. It skips a run
whose compile cache states say it was cold, for the reason the ratchet does. So
the metric name, the `durationSeconds` key and the `compileCacheStates` tag have
a reader outside the gate, and a change to any of them is a change to the tile.

A later PR run reads its ratchet baseline from the `perf-metrics` artifact of the
`main` run for the base-branch commit it merged, or of the nearest ancestor of
that commit which has one; there is no separate history store. It finds that run
by ordering the recent `main` runs from the nearest ancestor of that commit
outwards — leaving out the runs for commits it does not contain — and then
reading one run at a time, stopping as soon as every metric has a baseline.
Usually the nearest run measured every metric, and that is the only baseline
artifact read; reading further back happens when a run uploaded nothing, ran
cold, or measured a metric no nearer run did. The runs the walk read are the
ones the "Baseline source runs" log group names.

The workflow downloads the current run's `coverage-profile-*` artifacts before
starting `tasks/coverage-check.ts`. `COVERAGE_ARTIFACTS_DIR` points the script at
one subdirectory per artifact. The download step checks the artifact digests. The
script separately checks the expected artifact names
(`EXPECTED_COVERAGE_ARTIFACT_NAMES`). It also rejects an artifact containing no
coverage files. A manual run without the environment variable uses the GitHub API
download path instead.

### Measuring a before/after locally

The gate reports a group total rather than a per-line diff, so localizing a rise
means measuring the same group twice: once with the branch's tree, once with the
tree it will merge onto. Set `DENO_COVERAGE_DIR` for each run and convert with
`tasks/write-coverage-lcov.ts`, exactly as the CI jobs do, then compare the two
LCOV reports' zero-hit lines across the files the branch changed.

Take both measurements from the same base. Rebasing between them straddles two
trees and the delta stops meaning anything, so rebase first and measure after.

A local total will not match CI's. CI sums a group over every job that loads its
files and one local suite loads a subset, so the absolute numbers differ. The
offset is constant between two runs of the same suite, which is what leaves the
delta comparable when the totals are not.

The baseline half checks the merge base out over the packages being measured, so
for the length of that run the worktree holds the base's code rather than the
branch's. A tree sampled during it reads as though the branch had been reverted.
It has not been: the branch's work is in its commits, and anything uncommitted is
in the stash the measurement pushed. `git stash list` and
`git grep <symbol> <branch-sha> -- <paths>` settle that from outside the run,
without waiting for it to finish. Restore with `git checkout HEAD -- <paths>`
followed by `git stash pop`.

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

Every run stamps its own `perf-metrics.json`, so a baseline run's coldness is
read straight off the artifact that run published. Before writing the stamp, a
run fills in any family whose cache-state artifact did not arrive, using the
compile fingerprint: `tasks/compile-cache-state.ts` mirrors the `cc-*` key globs
(drift-guarded by a test that parses the workflow) and compares the run's commit
against the commit whose cache it would have restored — the pull request's own
changed files, or the previous `main` run for a push. A family with no recorded
state is filled cold when those paths changed. Recorded states are ground truth
and always win. The rate-limit skip path writes the same stamped artifact, so a
run cut short still tells later runs whether it was cold.

Neither source is complete. Fingerprint inference cannot see non-fingerprint
cold causes (cache eviction, cache-service outages), and a run whose cache-state
artifacts and fingerprint comparison both failed publishes no stamp at all. A
run with no recorded state is treated as not-cold and may still be used as a
baseline.

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
coverage is what an IDE uses to color the gutter, which is what this file is
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
(`GetPatternCoverage`), and the harness pulls them with `page.evaluate` — one
batched dump per runtime, not a per-hit round trip. Every realm runs the same
instrumented bytes, so the fileName-plus-span-id keys line up: a realm that only
warm-loaded already-instrumented bytes reports hits that merge cleanly against
the realm that compiled them and holds the spans. The harness merges the realms'
hits and writes a `*.pattern-coverage.lcov` tagged
`TN:pattern-runtime-integration`, which the job uploads in its
`coverage-profile-*` artifact.

### One report per test file, not one per shard

`deno test` runs each test file in its own isolate. A shard's files therefore
hold separate instances of the harness module, each with its own collector and
its own space, and each writes its own `*.pattern-coverage.lcov` under
`CF_PATTERN_COVERAGE_DIR`. The gate copies and joins every `.lcov` in an
artifact, so a shard's coverage arriving in several files reads the same as one,
and a report is named apart from every other in the run for that reason.

The isolation runs the other way as well. A test file that runs its patterns
only through a pieces controller in the test process, with no page to dump from,
never reaches the write and contributes nothing — `all.test.ts` is the case in
the tree.

### The dump has to happen before the runtime is dropped

A worker's collector lives and dies with the runtime that built it. A shell
builds a new runtime whenever the page navigates and whenever its identity is
set — `shouldRecreateRuntime` compares the `Identity` object, and the integration
harness mints a fresh one from what crosses the page boundary — so one suite runs
through several runtimes, and every hit a dropped runtime holds is gone. A suite
that drives one page through two logins has two runtimes and two dumps to take:
one before the second navigation, and one before the harness disposes what that
navigation left. The pull happens in three places — before a login, before the
harness disposes a runtime, and on the page itself
(`Page.addBeforeUnloadHook`), which is what covers a reload and a page close as
well as a `goto`.

Taking only the last runtime's dump is what makes a line's coverage turn on the
environment, which the section above rules out. The lines at risk are the ones a
flow reaches late — a derived expression that runs when the view renders it, a
handler body that runs when the user gets that far. Whether the runtime holding
those hits is the one still standing at teardown depends on how the run was
timed and which shard the file landed in, and a line that drops out that way is
charged to whichever pull request happened to reshuffle the shards.

A dump that comes back empty-handed is reported, with one exception: a page that
never booted a runtime holds nothing, and is normal. A page that cannot be
reached at all, a runtime that does not answer the request, and a worker built
with no collector each name what was lost on the job's log. Coming back with
hits and no spans is not one of those — that is exactly what a realm that
warm-loaded somebody else's instrumented bytes reports, and those hits key
against the spans the compiling realm registered.

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
