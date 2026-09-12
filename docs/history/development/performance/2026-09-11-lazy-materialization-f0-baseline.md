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
| Server processes    | Toolshed, the CLI, and the background piece service read the variable through `experimentalOptionsFromEnv`; unset means on                              |
| Browser shell       | Has no build-time define for this flag ([`shell/src/lib/env.ts`](../../../../packages/shell/src/lib/env.ts) declares five others), so it runs the `Runtime` default and cannot be rolled back through the environment |
| Detached clients    | `EXPERIMENTAL_FLAG_AUTHORITY` assigns the flag to the server, so a `cf` binary not built beside its server takes the posture that server publishes      |
| Lift arguments      | Marked lazy when the flag is on; the mark is cleared before the result is written                                                                       |
| Handler arguments   | Never marked; eager in both flag postures                                                                                                               |

The registry entry in
[Experimental options](../../../development/EXPERIMENTAL_OPTIONS.md#lazymaterialization)
names the owner and the removal condition.

## Where the flag and the mark are consumed

Every non-test site that reads the flag or the transaction mark, at the pinned
revision:

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
  [`builtins/collection-index-key.ts`](../../../../packages/runner/src/builtins/collection-index-key.ts);
  consumed only by the lift path's post-run in `runner.ts`.

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
post-run with an undefined result — with one gap. `postRun` is assigned only
after the synchronous invocation returns, so a refusal the body throws
synchronously reaches the catch while `postRun` is still unassigned, and the
catch's `postRun?.(undefined)` does nothing: the mark stays set, the refusal
stays recorded, and no result is written, leaving the previous result standing.
The asynchronous rejection path assigns `postRun` first and does dispose. Result
writing and diffing in `#writeJavaScriptActionResult` run unmarked, so they
read eagerly.

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
   second read-only transaction, walked to collect every `Cell` so its
   document can be synced before the body runs.
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

- The dependency preflight and the presync above. Both exist to walk
  everything the handler might reach, so a view that materializes on touch
  cannot serve them.
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
dispatch left running come after it. After each sample it reads the last
value of each phase timer the runtime keeps, so the whole and the parts come
from the same dispatch, and checks the counter against the expected value.
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

Each variant requested seven samples after one warmup. Per-sample values
below are the median of the eight recorded samples after the first. The storage
manager is the in-memory emulation, so commit cost is local and no network is
represented. No linked rows and no cross-space context are represented; the
representative-copy limitations recorded in the
[lunch-poll rehearsal](2026-09-12-representative-lunch-poll-rehearsal.md)
carry forward unchanged, and the live poll was not touched.

### Timing, in milliseconds per dispatch

`Preflight` is the last of the two preflight passes a dispatch runs, so the
dispatch pays about twice the figure shown. `Handler` is the scheduler's
timer around the whole handler action, which contains `ArgRead`, `Body`, and
`PostRun`. `Commit` sums the transaction's three commit timers. `Rest` is
what no timer attributes: the elapsed time less the presync, two preflight
passes, the handler action, and the commit.

| Rows  | Workload      | Elapsed | Presync | Preflight | ArgRead | Body  | PostRun | Handler | Commit | Rest  |
| ----- | ------------- | ------- | ------- | --------- | ------- | ----- | ------- | ------- | ------ | ----- |
| 74 | `scalarKey` | 17.2 | 0.44 | 3.61 | 0.10 | 0.12 | 0.15 | 0.82 | 0.13 | 8.6 |
| 74 | `scalarGet` | 19.1 | 0.32 | 3.51 | 0.09 | 0.69 | 0.16 | 2.09 | 0.59 | 9.1 |
| 74 | `walk` | 22.7 | 0.28 | 2.55 | 0.07 | 1.23 | 0.17 | 3.28 | 0.90 | 13.2 |
| 74 | `mutate` | 15.3 | 0.26 | 1.82 | 0.07 | 0.53 | 0.11 | 1.23 | 0.22 | 10.0 |
| 74 | `plainScalar` | 12.5 | 0.69 | 1.35 | 0.49 | 0.04 | 0.12 | 1.37 | 0.40 | 7.3 |
| 74 | `plainWalk` | 31.8 | 1.69 | 2.97 | 1.08 | 0.05 | 0.16 | 2.98 | 0.96 | 20.2 |
| 296 | `scalarKey` | 33.5 | 0.57 | 10.57 | 0.10 | 0.13 | 0.15 | 0.87 | 0.19 | 10.7 |
| 296 | `scalarGet` | 39.3 | 0.39 | 7.33 | 0.08 | 2.53 | 0.20 | 6.32 | 1.90 | 16.0 |
| 296 | `walk` | 72.6 | 0.35 | 7.40 | 0.07 | 4.88 | 0.24 | 12.60 | 4.88 | 40.0 |
| 296 | `mutate` | 30.8 | 0.41 | 6.52 | 0.07 | 0.84 | 0.12 | 1.59 | 0.25 | 15.6 |
| 296 | `plainScalar` | 29.7 | 2.16 | 4.29 | 1.65 | 0.04 | 0.13 | 4.66 | 1.20 | 13.1 |
| 296 | `plainWalk` | 54.8 | 5.06 | 4.79 | 4.30 | 0.05 | 0.16 | 9.35 | 3.19 | 27.6 |
| 1,184 | `scalarKey` | 55.6 | 0.41 | 18.32 | 0.07 | 0.10 | 0.11 | 0.56 | 0.10 | 17.9 |
| 1,184 | `scalarGet` | 99.9 | 0.43 | 20.50 | 0.07 | 8.97 | 0.21 | 17.44 | 5.70 | 35.3 |
| 1,184 | `walk` | 208.6 | 0.45 | 21.57 | 0.07 | 19.71 | 0.23 | 38.15 | 11.93 | 115.0 |
| 1,184 | `mutate` | 78.3 | 0.42 | 19.61 | 0.07 | 1.97 | 0.10 | 2.80 | 0.36 | 35.5 |
| 1,184 | `plainScalar` | 125.4 | 9.87 | 21.06 | 7.99 | 0.05 | 0.19 | 16.81 | 5.65 | 50.9 |
| 1,184 | `plainWalk` | 227.9 | 19.33 | 19.06 | 19.41 | 0.07 | 0.21 | 38.62 | 11.94 | 119.8 |

Four earlier runs of this benchmark on the same revision, before its timed
interval was narrowed to the commit callback, put `scalarKey` at 1,184 rows
between 59 and 97 ms elapsed with an 18 to 30 ms preflight pass, and `walk`
between 161 and 305 ms with a 16 to 35 ms body. The runs agree on the ordering
of the workloads and on which phases carry the time; the absolute figures move
by up to a half between runs on this machine and are observations, not
thresholds.

The preflight telemetry splits each pass into populating the dependencies,
converting the transaction to a reactivity log, and collecting invalid
upstream nodes. At 1,184 rows the populate step is 85 to 95 percent of a pass
in every workload and the other two steps are 2 to 7 ms each; the dependency
commit and scheduling steps are under 0.1 ms. That split is taken from the
count pass, with accounting on, and is attribution rather than a timing claim.

`Rest` grows with the list on the whole-list workloads: 115 to 120 ms at
1,184 rows for `walk` and `plainWalk` against 18 ms for `scalarKey`. No
existing timer covers the work between the handler action and the commit —
converting the dispatch transaction to a reactivity log, collecting trusted
write candidates, and preparing the policy digest — nor the preflight's steps
past populate, so this record cannot attribute it further. Doing so needs
timers at those seams and is a lead for F5's remeasurement.

### Counts, from one dispatch with accounting on

Link resolutions are the `scheduler.read-attempt` counter per attempt kind.
The preflight column lists both passes. Proxy accesses were zero in every
attempt: nothing on the handler path reads through a proxy today.

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
collection before and after each dispatch on a shared runtime, gave deltas of
both signs between 1.5 MB below and 1.3 MB above zero with no relation to the
workload, so this record makes no retention claim; a retention measurement
needs a dedicated runtime per dispatch and more samples than this pass takes.

## Findings

1. **The dependency preflight is the largest fixed cost of a handler
   dispatch, and it does not depend on what the handler reads.** At 1,184
   rows it resolves one link per row, twice, whatever the workload. For the
   handle-context workloads that read little, it is most of what the timers
   attribute; for the whole-list workloads the handler action is as large or
   larger, and a share of the elapsed time remains unattributed by any timer
   (the `Rest` column). The first preflight pass is reported skipped and the
   second runs; both walk the full list. Which condition skips the first pass
   was not established here and is a lead for the scheduler's owner.
2. **The argument read is negligible for a handle context and linear for a
   plain one.** With `Writable<Vote[]>` the read mints a handle in 0.1 to 0.2
   ms at every size. With `Vote[]` it materializes every row, costing 10 to 20
   ms at 1,184 rows, and the presync pays the same again. The lunch poll's
   handlers all bind handles.
3. **Whole-list reads inside the body cost what a plain context costs, per
   read.** `votes.get()` inside the handler is 19 to 21 ms at 1,184 rows
   whether the body then takes one element or sums them all, and the commit
   that follows a whole-list read is 7 to 14 ms against 0.1 to 0.4 ms for a
   keyed read. The write is the same in both, so the difference is the read
   set the commit carries.
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
argument read lazy would save under a millisecond for a handle context and 10
to 20 ms at 1,184 rows for a plain one, while the two preflight passes spend
two to three times that on every dispatch regardless. A lazy body read of a handle could save the
19 to 21 ms a whole-list `get()` costs when the body touches little of it, at
the price of finding 4 above. Those are the two consequences F1's contract and
prototype have to weigh, with the same benchmark extended by a posture
dimension so the comparison holds inputs fixed.
