# Reactive action read accounting

`runtime.scheduler.setReadAccountingEnabled(true)` enables counters for
subsequent reactive action bodies, including builtins and scheduler effects. It
defaults off. A run retains the setting it started with, even if the setting
changes while an asynchronous body is suspended.

`cf test --verbose --stats-threshold 0` enables accounting and prints every
step's measured work, with a separate initialization report. Rows are sorted by
proxy accesses. Authored rows name the verified source location; builtins and
host actions use their module name or action ID. `--stats-action-limit` limits
displayed rows without truncating totals. The usual stats threshold controls
which step reports print; initialization always prints in verbose mode.

## Counter contract

| Counter             | Definition                                                                                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `proxyAccesses`     | Property or element value requests through schema-backed or query-result views, including repeats, missing properties, array length, and descriptor values. Array iteration and methods count the elements they materialize even when they bypass a JavaScript proxy trap.     |
| `linkResolutions`   | Actual stored-link hops taken by link resolution, schema traversal. Replaying a memoized resolution adds no hops. A followed link with an absent target counts; a scope-blocked or cycle-rejected hop does not.                                                                |
| `distinctDocuments` | Distinct `(space, entity ID)` pairs in the transaction's recorded read activities. Repeated paths and scopes in one entity contribute one document. Machinery reads and reads ignored for scheduling count. Inline data URI values that produce no read activity do not.       |
| `dependencies`      | Recursive and shallow scheduling read paths at body completion, compacted separately with the scheduler's own compaction rules. Ignored scheduling reads do not count. This is the body's dependency footprint, not the eventual union of all served instances' subscriptions. |

Property reads performed by runtime helpers count as well as reads directly
written in the pattern. Fetching a method or symbol, and enumerating keys
without requesting descriptor values, contributes no proxy access. A method that
materializes an entire array counts that materialization even if its callback
stops early. Plain eager values produce no proxy accesses; the work to
materialize them remains visible through link and document counts.

The counters intentionally differ. A repeated property read can add an access
while adding neither a link hop nor a document. A single property can cross
several links. Dependency compaction can turn many reads into one subscription
path.

## Execution boundary

Accounting starts immediately before invoking the scheduler action and ends when
its body resolves or throws, at the same boundary as its execution-time sample.
It covers argument materialization and result construction performed by that
invocation. Failed and retried runs each contribute their work.

Accounting belongs to the underlying storage transaction. Read-only and
nonreactive wrappers share its counters; unrelated transactions and other
runtimes do not. Asynchronous code retains its transaction's ownership.

Commit preparation, commit processing, event-handler dispatch, and diagnostic
idempotency reruns are outside this boundary. These reports describe reactive
action bodies, not the entire cost of an interaction. Whole-step budgets need
the additional execution coverage tracked by
[the implementation sequence](../plans/pattern-computation-cost-implementation.md).

The probes allocate no counter or document sets when disabled. Enabled runs
allocate two integer counters; completion computes document cardinality from the
existing storage read activities and dependencies from the existing reactivity
log. Probes never write read metadata or add subscriptions. The disabled probes
still perform a weak-map lookup; their overhead must be measured before claiming
an instrumentation-free production path.

## Results and aggregation

`ActionStats.reads` contains the number of measured runs, the last measured run,
and cumulative totals. Runs with accounting disabled still increment the
ordinary run count but leave these measurements untouched. Totals for documents
and dependencies sum per-run cardinalities; they are not unions across runs. CLI
output calls them `document-runs` and `dependency-runs` to make that distinction
explicit.

Each `scheduler.run.complete` telemetry marker carries the run's measurements
when enabled. The CLI aggregates these events, so actions removed from the graph
or evicted from the bounded statistics map still contribute to the step's
report. It adds each run once rather than combining parent-inclusive totals with
their children's totals.

The implementation is in `packages/runner/src/read-accounting.ts`, the scheduler
completion path, and `packages/cli/lib/read-cost-report.ts`.
