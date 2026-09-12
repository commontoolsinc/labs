---
status: historical
created: 2026-09-11
archived: 2026-09-11
reason: "F0 baseline of the lazy-materialization fast-follow: entry-point inventory, flag posture, and the per-phase cost of one handler dispatch at three list sizes."
---

# Lazy materialization fast-follow: F0 baseline

This is the F0 record for the
[lazy materialization fast-follow](../../../plans/lazy-materialization-fast-follow.md).
It pins the runtime revision the later stages compare against, lists every
place the `lazyMaterialization` flag and the transaction mark are consumed,
names the reads on the handler path that stay eager, and measures what one
dispatched handler event costs, phase by phase, over lists of 74, 296, and
1,184 rows. It changes no runtime behavior. The one source change it carries
is a phase timer around the handler presync, so that the presync can be read
back beside the dispatch's other phases.

## Revision and posture

| Item                | Value                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime revision    | `a44d9389c3783768cb2b3ad194751a9964dc7027`                                                                                                              |
| Deno                | 2.9.4 (aarch64-apple-darwin), Apple M5                                                                                                                  |
| Flag default        | `lazyMaterialization` resolves an unset value to `true` in `Runtime`'s constructor ([`runtime.ts`](../../../../packages/runner/src/runtime.ts))         |
| Environment         | `EXPERIMENTAL_LAZY_MATERIALIZATION`, through `EXPERIMENTAL_ENV_VARS` in [`runtime-presets.ts`](../../../../packages/runner/src/runtime-presets.ts)      |
| Server processes    | Toolshed, the background piece service, and `cf dev` read the variable through `experimentalOptionsFromEnv`; unset means on                              |
| Browser shell       | Has no build-time define for this flag ([`shell/src/lib/env.ts`](../../../../packages/shell/src/lib/env.ts) declares five others), so it runs the `Runtime` default and cannot be rolled back through the environment |
| Deployed `cf` client | `experimentalOptionsForDeployedClient` resolves the flag by `adoptServerExperimentalOptions`: an explicit environment value wins, otherwise the posture the server publishes, otherwise the built-in default |
| Lift arguments      | Marked lazy when the flag is on; the mark is cleared before the result is written                                                                       |
| Handler arguments   | Never marked; eager in both flag postures                                                                                                               |

The registry entry in
[Experimental options](../../../development/EXPERIMENTAL_OPTIONS.md#lazymaterialization)
names the owner and the removal condition.

## Where the flag and the mark are consumed

The non-test sites that read the flag, the transaction mark, or the refusal
at the pinned revision, found by searching for their names:

- **The flag.** `runtime.ts` declares and defaults it; `runtime-presets.ts`
  maps the environment variable and assigns server authority; `runner.ts`
  reads it once, at the lift path's argument read, to decide whether to mark
  the transaction.
- **The mark.** `markLazyMaterialize` and `isLazyMaterialize` on
  `IExtendedStorageTransaction` ([`storage/interface.ts`](../../../../packages/runner/src/storage/interface.ts)),
  implemented on the transaction and on `TransactionWrapper` in
  [`extended-storage-transaction.ts`](../../../../packages/runner/src/storage/extended-storage-transaction.ts),
  with the per-layer set in
  [`reactivity-log.ts`](../../../../packages/runner/src/storage/reactivity-log.ts).
  `validateAndTransform` in [`schema.ts`](../../../../packages/runner/src/schema.ts)
  branches to the view on a marked transaction and keeps a marked transaction
  rather than swapping a finished one for a fresh read;
  `createQueryResultProxy` in
  [`query-result-proxy.ts`](../../../../packages/runner/src/query-result-proxy.ts)
  pins a schema-less proxy to its transaction when marked.
- **The refusal.** `noteSchemaRefusal` and `takeSchemaRefusal` on the same
  interface, recorded by the view in
  [`schema-view.ts`](../../../../packages/runner/src/schema-view.ts), by the
  unresolved-input arm in `schema.ts`, and by the collection index key
  builtin in
  [`builtins/collection-index-key.ts`](../../../../packages/runner/src/builtins/collection-index-key.ts).
  `clearSchemaRefusal`, on the same interface, is how the view withdraws a
  refusal it catches itself — an optional property's — so that only the
  refusals a reader saw stay recorded. The lift path's post-run in
  `runner.ts` is the one site that takes a recorded refusal to dispose of
  the run.

Tests that name the flag or the mark are listed under
[What the existing tests prove](#what-the-existing-tests-prove).

## Entry points and eager reads

### The lift path

`#instantiateJavaScriptActionNode` in
[`runner.ts`](../../../../packages/runner/src/runner.ts) marks the action's
transaction when the flag is on, reads the argument with the transaction bound
to the schema, runs the body, and in its post-run clears the mark and takes any
recorded refusal before normalizing and writing the result. A refusal thrown
out of the body, or rejected out of an async body, is routed to the same
post-run with an undefined result — with one gap at the pinned revision.
`postRun` is assigned only after the synchronous invocation returns, so a
refusal the body throws synchronously reaches the catch while `postRun` is
still unassigned, and the catch's `postRun?.(undefined)` does nothing: the
mark stays set, the refusal stays recorded, and no result is written, leaving
the previous result standing. The asynchronous rejection path assigns
`postRun` first and does dispose. A separate change carries the fix, which
assigns `postRun` before the body is invoked, with a test that fails at the
pinned revision; the vintage replay gate shows that fix clearing a persisted
derived value the defect had preserved, so it waits on that gate's owner.
Result writing and diffing in `#writeJavaScriptActionResult` run unmarked, so
they read eagerly.

### The handler path

`#instantiateJavaScriptHandlerNode` in the same file never marks its
transaction. In dispatch order, the reads it and the scheduler take are:

1. **Dependency preflight**, in `preflightQueuedEventDependencies`
   ([`scheduler/events.ts`](../../../../packages/runner/src/scheduler/events.ts)).
   The handler's `populateDependencies` reads every declared writable input
   through `#populateDeclaredSchedulerReads`, which calls `.get()` on each one
   with the input's own schema, and reads the event payload through
   `#populateHandlerEventSchedulerReads` with `traverseCells: true`. A
   handler with no declared reads falls back to reading the whole argument
   with `traverseCells: true`. All of it is eager, on a read-only transaction
   of its own, and its purpose is to find invalid upstream computations and
   in-flight loads the handler would read through. The measurement below
   shows this pass running twice per dispatch.
2. **Presync**, in `dispatchQueuedEvent` (same file), through the handler's
   `presyncInputs`: an eager read of the whole argument under its schema on a
   second read-only transaction, walked to depth sixteen to collect the
   `Cell`s it finds so their documents can be synced before the body runs. A
   property whose access throws is skipped, and a cell below the depth cap is
   not collected.
3. **The closed-world event gate**, `closedWorldEventRejection` in
   `runner.ts`: judges the raw event payload against a closed event schema
   without reading through a cell. It runs before the argument read.
4. **The argument read**, `#readJavaScriptArgument`: one eager `.get()` of the
   immutable inputs cell under the generated handler schema, whose root
   requires `$ctx` and leaves `$event` optional. An `undefined` result sets
   `dispatchedHandlerNotRun`, which the scheduler's finalize withdraws and
   re-runs rather than sealing.
5. **The body**, `#invokeJavaScriptImplementation`, which splits the argument
   into `$event` and `$ctx`. Everything the body reads through a handle is an
   ordinary eager `.get()`.
6. **Post-run**, `#handleJavaScriptHandlerResult`: the receipt cell's raw
   read, and for a reactive result, a result pattern instantiated and run
   through the normal eager path.
7. **Trusted-write collection**, `trustedEventWriteCandidatesFromTransaction`
   in [`scheduler/reactivity.ts`](../../../../packages/runner/src/scheduler/reactivity.ts),
   after the body returns: reads the transaction's write log, not cells.
8. **Commit**, on the dispatch transaction, with the read log as its
   preconditions.

Reads 1, 2, 4, and 6 are the eager materializations. The handler's post-run
does not consult `takeSchemaRefusal`, so a refusal recorded on a handler
transaction goes unread. One site records a refusal without consulting the
mark: `resolveCollectionKey` in
[`builtins/collection-index-key.ts`](../../../../packages/runner/src/builtins/collection-index-key.ts)
notes one whenever a cell key resolves through a document the replica does not
hold. A handler reaching it through a collection index lookup, and catching the
throw, commits whatever it wrote before.

### Eager reads that unmarked callers still require

These stay whatever F2 and F4 decide:

- The dependency preflight and the presync above. Both exist to walk what
  the handler might reach before it runs, so a view that materializes on
  touch cannot serve them.
- Result writing and diffing on both paths, which compare whole values.
- Every read the scheduler takes on its own transactions.
- The standing-handle reading of the schema-less proxy, which long-lived
  consumers rely on and which only an unmarked transaction provides.

## What the existing tests prove

Three files stand nearest the handler question, and only two exercise a
dispatched handler:

- [`lazy-materialization-runner.test.ts`](../../../../packages/runner/test/lazy-materialization-runner.test.ts)
  marks a transaction by hand and reads a cell through it. It covers the view
  and the refusal on a marked read. It instantiates no lift and dispatches no
  handler, so it is not evidence about either runner path.
- [`stream-handler-unresolved-argument.test.ts`](../../../../packages/runner/test/stream-handler-unresolved-argument.test.ts)
  dispatches to a compiled handler whose argument does not resolve, and pins
  the withdraw-and-re-run disposition with the flag on its default.
- [`scheduler-event-handler-not-run.test.ts`](../../../../packages/runner/test/scheduler-event-handler-not-run.test.ts)
  pins the scheduler's handling of `dispatchedHandlerNotRun` for client
  dispatches: re-run, park on loads, backoff limit, one-shot, and the
  events-down echo.

The lift path's flag-sensitive behavior is pinned by
[`patterns-lift.test.ts`](../../../../packages/runner/test/patterns-lift.test.ts)
(a forwarding lift runs once under the view and twice eager) and the view
itself by `schema-view.test.ts`, `lazy-view-epoch.bench.ts`,
`query-result-proxy-transaction-lifetime.test.ts`, `link-resolution-memo.test.ts`,
`read-accounting.test.ts`, `unknown-reference-materialization.test.ts`, and
`extended-storage-transaction.test.ts`. The toolshed's `runtime-options.test.ts`
and `routes/meta/meta.test.ts` and the runner's `experimental-options.test.ts`
pin how the flag is read and published.

## Measurement

### Method

[`handler-dispatch-cost.bench.ts`](../../../../packages/runner/test/handler-dispatch-cost.bench.ts)
compiles one pattern with six handlers over a `votes` list and an `out`
counter, seeds the list with 74, 296, or 1,184 inline rows of the same shape
the [scalar read width baseline](2026-09-11-lazy-scalar-read-width.md) used,
and sends one event per sample through the scheduler. The timed interval runs
from the send to the commit callback; the drains that wait for whatever the
dispatch left running come after it. Around each sample it snapshots the
accumulated time of each phase timer the runtime keeps, so a phase's figure
is what it added during that dispatch, however many times it ran, and a
phase that did not run adds nothing; the whole and the parts come from the
same dispatch, and the counter is checked against the expected value.
The one workload that writes has its list re-seeded after each sample,
outside the timed interval, so every sample dispatches over a list of the
stated size. The phase timers are kept once per process, with one active
start per key, so the benchmark runs its runtimes one at a time.

| Workload      | Bound context      | Body                                                                 |
| ------------- | ------------------ | -------------------------------------------------------------------- |
| `scalarKey`   | `Writable<Vote[]>` | Reads one element by key, as the lunch poll reaches one vote         |
| `scalarGet`   | `Writable<Vote[]>` | Reads the whole list and takes one element                           |
| `walk`        | `Writable<Vote[]>` | Reads the whole list and sums every row                              |
| `mutate`      | `Writable<Vote[]>` | Writes one element by key and pushes one row                         |
| `plainScalar` | `Vote[]`           | The argument read materializes every row; the body takes one element |
| `plainWalk`   | `Vote[]`           | The argument read materializes every row; the body sums them         |

Read counts, preflight telemetry, scheduler node counts, and a retained-heap
probe are collected in a separate pass with accounting on, before any timed
sample runs, on a fresh runtime per variant so no workload's write reaches
another's counts. The timed samples run with accounting off.

From the repository root:

```sh
deno bench -A --v8-flags=--expose-gc packages/runner/test/handler-dispatch-cost.bench.ts
```

Each variant requested seven samples after one warmup; nine invocations were
recorded per variant, and the values below are the median of the eight after
the first. The storage
manager is the in-memory emulation, so commit cost is local and no network is
represented. No linked rows and no cross-space context are represented; the
representative-copy limitations recorded in the
[lunch-poll rehearsal](2026-09-12-representative-lunch-poll-rehearsal.md)
carry forward unchanged, and the live poll was not touched.

### Timing, in milliseconds per dispatch

`Populate` is the dependency-population step of the preflight, summed over
the two passes every sample ran, and `Steps` the sum of the preflight's four
other timed steps (converting the transaction to a log, the dependency
commit, collecting invalid upstream nodes, scheduling them) over the same
passes. `Handler` is the scheduler's timer around the handler action, which
spans `ArgRead`, `Body`, and `PostRun`, then the trusted-write collection
after the body and the commit's preparation and synchronous steps; `Commit`
sums the transaction's three commit timers, which run inside that span.
`Rest` is what no timer attributes: the elapsed time less the presync, the
two preflight columns, and the handler action.

| Rows  | Workload      | Elapsed | Presync | Populate | Steps | ArgRead | Body  | PostRun | Handler | Commit | Rest  |
| ----- | ------------- | ------- | ------- | -------- | ----- | ------- | ----- | ------- | ------- | ------ | ----- |
| 74 | `scalarKey` | 13.9 | 0.33 | 5.73 | 0.84 | 0.09 | 0.12 | 0.15 | 0.75 | 0.13 | 6.3 |
| 74 | `scalarGet` | 18.7 | 0.43 | 6.12 | 0.87 | 0.13 | 0.87 | 0.16 | 2.33 | 0.60 | 8.9 |
| 74 | `walk` | 23.0 | 0.38 | 4.79 | 0.78 | 0.09 | 1.45 | 0.21 | 3.79 | 1.03 | 13.2 |
| 74 | `mutate` | 18.3 | 0.37 | 5.82 | 0.85 | 0.08 | 0.73 | 0.17 | 1.79 | 0.30 | 9.5 |
| 74 | `plainScalar` | 22.4 | 1.25 | 7.15 | 0.87 | 0.93 | 0.06 | 0.26 | 2.58 | 0.70 | 10.5 |
| 74 | `plainWalk` | 31.6 | 2.39 | 6.07 | 0.84 | 1.52 | 0.07 | 0.23 | 3.81 | 1.13 | 18.5 |
| 296 | `scalarKey` | 22.0 | 0.43 | 11.73 | 2.25 | 0.07 | 0.11 | 0.14 | 0.62 | 0.12 | 7.0 |
| 296 | `scalarGet` | 28.8 | 0.29 | 10.77 | 1.34 | 0.06 | 2.09 | 0.16 | 4.55 | 1.57 | 11.8 |
| 296 | `walk` | 57.7 | 0.39 | 12.87 | 1.74 | 0.08 | 5.00 | 0.24 | 10.68 | 3.31 | 32.0 |
| 296 | `mutate` | 37.5 | 0.58 | 17.29 | 3.52 | 0.08 | 0.83 | 0.11 | 1.60 | 0.26 | 14.5 |
| 296 | `plainScalar` | 36.6 | 2.78 | 11.85 | 1.61 | 2.05 | 0.06 | 0.19 | 6.07 | 1.49 | 14.3 |
| 296 | `plainWalk` | 108.4 | 10.71 | 18.96 | 2.37 | 6.77 | 0.09 | 0.26 | 14.74 | 5.10 | 61.7 |
| 1,184 | `scalarKey` | 70.6 | 0.45 | 48.09 | 7.23 | 0.07 | 0.11 | 0.14 | 0.62 | 0.11 | 14.3 |
| 1,184 | `scalarGet` | 108.2 | 0.49 | 43.38 | 7.47 | 0.07 | 10.63 | 0.26 | 19.69 | 5.88 | 37.1 |
| 1,184 | `walk` | 251.9 | 0.54 | 63.30 | 9.50 | 0.08 | 27.64 | 0.30 | 52.18 | 14.46 | 126.4 |
| 1,184 | `mutate` | 101.0 | 0.53 | 55.67 | 7.56 | 0.08 | 2.44 | 0.15 | 3.76 | 0.45 | 33.5 |
| 1,184 | `plainScalar` | 205.2 | 13.50 | 64.39 | 9.49 | 12.11 | 0.08 | 0.28 | 24.36 | 8.68 | 93.4 |
| 1,184 | `plainWalk` | 339.9 | 26.89 | 72.03 | 8.47 | 27.70 | 0.10 | 0.37 | 55.51 | 18.23 | 177.0 |

Seven earlier runs of this benchmark on the same revision, some with a wider
timed interval, some reading each timer's last sample rather than its
accumulated time, and some while a review or a test suite shared the machine,
put `scalarKey` at 1,184 rows between 56 and 99 ms elapsed and `walk` between
161 and 380 ms. The runs agree on the ordering of the workloads and on which
phases carry the time; the absolute figures move by up to a factor of two
between runs on this machine, most of that in the runs taken under shared
load, and are observations, not thresholds.

`Rest` grows with the list on the whole-list workloads: at 1,184 rows it is
14 ms for `scalarKey`, 37 for `scalarGet`, 126 for `walk`, and 177 for
`plainWalk`. It is the time outside every timer this record reads: the
scheduler's ticks between the phases, the presync transaction's setup, the
commit's asynchronous remainder after its synchronous steps, and the
callback's delivery. That it grows with the read set the commit carries makes
the commit's asynchronous part the likely holder, but this record does not
attribute it; a timer around the commit promise is what would, and that is a
lead for F5's remeasurement.

### Counts, from one dispatch with accounting on

Link resolutions are the `scheduler.read-attempt` counter per attempt kind.
The preflight column lists both passes. Proxy accesses were zero in every
attempt of these workloads, whose handlers declare an argument schema and so
read eagerly; a handler without one reads its argument through the
schema-less query-result proxy and would count accesses.

| Rows  | Workload      | Preflight links | Presync links | Event links | Preflight reads / shallow | First pass skipped |
| ----- | ------------- | --------------- | ------------- | ----------- | ------------------------- | ------------------ |
| 74 | `scalarKey` | 78, 78 | 6 | 7 | 101 / 818 | yes |
| 74 | `scalarGet` | 78, 78 | 6 | 80 | 101 / 818 | yes |
| 74 | `walk` | 78, 78 | 6 | 80 | 101 / 818 | yes |
| 74 | `mutate` | 78, 78 | 6 | 10 | 101 / 818 | yes |
| 74 | `plainScalar` | 78, 78 | 80 | 80 | 101 / 818 | yes |
| 74 | `plainWalk` | 78, 78 | 80 | 80 | 101 / 818 | yes |
| 296 | `scalarKey` | 300, 300 | 6 | 7 | 323 / 3,260 | yes |
| 296 | `scalarGet` | 300, 300 | 6 | 302 | 323 / 3,260 | yes |
| 296 | `walk` | 300, 300 | 6 | 302 | 323 / 3,260 | yes |
| 296 | `mutate` | 300, 300 | 6 | 10 | 323 / 3,260 | yes |
| 296 | `plainScalar` | 300, 300 | 302 | 302 | 323 / 3,260 | yes |
| 296 | `plainWalk` | 300, 300 | 302 | 302 | 323 / 3,260 | yes |
| 1,184 | `scalarKey` | 1,188, 1,188 | 6 | 7 | 1,211 / 13,028 | yes |
| 1,184 | `scalarGet` | 1,188, 1,188 | 6 | 1,190 | 1,211 / 13,028 | yes |
| 1,184 | `walk` | 1,188, 1,188 | 6 | 1,190 | 1,211 / 13,028 | yes |
| 1,184 | `mutate` | 1,188, 1,188 | 6 | 10 | 1,211 / 13,028 | yes |
| 1,184 | `plainScalar` | 1,188, 1,188 | 1,190 | 1,190 | 1,211 / 13,028 | yes |
| 1,184 | `plainWalk` | 1,188, 1,188 | 1,190 | 1,190 | 1,211 / 13,028 | yes |

The scheduler held one node before and after every dispatch: a handler with a
plain result adds nothing to the graph. The retained-heap probe, a full
collection before and after the one dispatch on each variant's fresh runtime,
gave deltas from 1.9 MB below zero to 0.1 MB above it with no relation to the
workload: a heap that shrinks across a dispatch is collecting the runtime's
own setup garbage, not measuring what the dispatch retained. This record makes
no retention claim; a retention measurement needs a runtime warmed past its
setup and more samples than this pass takes.

## Findings

1. **The dependency preflight is the largest fixed cost of a handler
   dispatch, and it does not depend on what the handler reads.** At 1,184
   rows it resolves one link per row, twice, whatever the workload, and its
   two populate steps take 43 to 72 ms of every dispatch. For the
   handle-context workloads that read little, that is most of what the
   timers attribute: 48 of `scalarKey`'s 71 ms. For the whole-list workloads
   the handler action is comparable, and a share of the elapsed time remains
   unattributed by any timer (the `Rest` column). The first preflight pass is
   reported skipped and the
   second runs; both walk the full list. Which condition skips the first pass
   was not established here and is a lead for the scheduler's owner.
2. **The argument read is negligible for a handle context and linear for a
   plain one.** With `Writable<Vote[]>` the read mints a handle in under a
   quarter of a millisecond at every size. With `Vote[]` it materializes every
   row: 2 to 7 ms at 296 rows and 12 to 28 ms at 1,184. The two plain workloads read the same
   list, and this measurement does not establish what separates their
   figures; each variant keeps its runtime across its samples and the
   workloads run in a fixed order, so neither position nor retention is
   ruled out. The presync pays about the same as the argument read. The lunch poll's handlers bind their collections as
   handles; the plain values they bind are scalars such as a name or a clock
   tick.
3. **A whole-list read inside the body costs what a plain context's argument
   read costs, and the commit after it grows with the read set.** The body
   timer spans the whole body, so it cannot isolate the read: at 1,184 rows
   `scalarGet`'s body, a whole-list read and one element, is 10.6 ms, and
   `walk`'s, the same read and a sum over every row, is 27.6 ms. The commit
   after either is 5.9 and 14.5 ms against 0.1 to 0.4 ms after a keyed read;
   the write is the same in all of them, so the difference is the read set
   the commit carries.
4. **A handler's read log is its commit precondition set.** The lunch poll's
   `addOption` and `removeOption` read the whole vote list on purpose so a
   concurrent cast conflicts with their commit. A view registers the paths
   the body touches and nothing else, so a lazy handler context would narrow
   that set on any handler that reads a list and touches part of it. This is
   a contract difference between the lift path, where a narrower read set
   only changes when a node re-runs, and the handler path, where it changes
   which concurrent writes a commit refuses. F1 has to decide it explicitly.
5. **Nothing on the handler path consumes a refusal.** Marking the handler
   transaction without adding the disposition would leave a caught refusal
   committing whatever the body wrote before it.

## What F1 takes from here

The measured lever on the handler path is not the argument read. Making the
argument read lazy would save under a millisecond for a handle context and 12
to 28 ms at 1,184 rows for a plain one, while the two preflight passes spend
43 to 72 ms on every dispatch regardless. A lazy body read of a handle could
save most of the 10.6 ms a whole-list `get()` and one element cost, and the
5.9 ms commit that follows, when the body touches little of the list, at the
price of finding 4 above. Those are the two consequences F1's contract and prototype
have to weigh, with the same benchmark extended by a posture dimension so the
comparison holds inputs fixed.
