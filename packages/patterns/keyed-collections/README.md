# Keyed Collections POC

This directory is a focused authoring/API proof of concept for collection
semantics that show up across most current patterns:

- ordered item collections;
- reference-addressed updates and removals via `equals()`;
- in-place field updates through `.key(index).key(field).set(...)`;
- nested collection append through a held item reference;
- latest-by composite vote semantics;
- count-by-option aggregate snapshots.

The coffee-origin poll fixtures use options like Ethiopia, Colombia, Kenya, and
Guatemala so the perf slices stay concrete without borrowing an external fandom
theme.

The item path models object-graph identity: callers hold an item reference and
later update/remove/nest through `equals()` plus narrow `.key(...)` writes. The
poll path intentionally uses scalar `optionId`/`voter` domain keys because it is
demonstrating latest-by and count-by semantics; those keys are not presented as
the general collection identity model.

The helper intentionally lives next to the fixture pattern instead of in
`commonfabric` because this is not a public API yet. It validates the cozy shape
over today's `Writable`/`Cell` capabilities, but it does **not** claim the
runtime-scale behavior we ultimately need for public-internet polls. The
original cozy fixture still derives aggregates from arrays; the v1 helper moves
that logic into maintained keyed cells and acts as the seam for future
runtime-owned keyed storage, incremental aggregates, and demand-aware view
materialization.

`keyed-collection-v1.ts` is the next step in that direction: a reusable
pattern-layer helper over today's cells. It provides ordered keyed records,
explicit key existence checks, encoded composite keys, array-to-keyed
replacement (`replaceOrderedFromArray`), pure filtered/count snapshots
(`filteredOrderedValues`, `countOrderedWhere`), and maintained
`latestBy + countBy` buckets. `main-v1.tsx` and `perf-v1.tsx` are adopter
fixtures for that helper; they should be treated as the current composable seam,
not as a finished runtime primitive.

`view-plan-v1.ts` adds a first declarative sidecar for advanced helper authors.
It lets a cozy helper describe a safe, closed `ViewPlan@1` such as `keyBy`,
`orderBy`, `latestBy`, `groupBy`, `countBy`, and `materialize`, plus the current
cell-helper fallback. The runtime does not consume these plans yet; they are the
typed contract we can validate and later lower to runtime-maintained views,
fine-grained invalidation, or SQLite pushdown without asking pattern authors to
write SQL or manage `byId`/`order`/tally cells by hand. `main-v1.tsx` publishes
two sidecars today: one for ordered coffee-origin options and one for latest
vote tallies.

`latest-by-count-delta-v1.ts` is the executable oracle for the next lowering
step. It defines the closed `latestByCountDelta@1` semantic operation that turns
old/latest-row + new/latest-row information into deterministic row-count and
bucket deltas. The current helper still performs the cell writes, but this delta
contract pins the insert/update/move/toggle/remove behavior that a future
runtime or backend materializer must preserve before we add storage-level
commutative operations.

`view-plan-executor-v1.ts` is the pure reference executor for the sidecar. It is
not an optimized runtime path; it interprets the closed ordered-values and
latest-rows/count-buckets plans over plain rows so helper, runtime, and backend
implementations have a shared executable semantics check.

`view-plan-parity-v1.ts` is the diagnostics-only hook that runs the reference
executor against a sanitized pattern output snapshot. The pattern's production
API stays unchanged; tests and `diagnose.ts` use the hook to report whether
published helper-maintained outputs match the `ViewPlan@1` semantics.

Run:

```bash
deno task cf check packages/patterns/keyed-collections/main.tsx --no-run
deno task cf check packages/patterns/keyed-collections/main-v1.tsx --no-run
deno task cf test packages/patterns/keyed-collections/main.test.tsx --verbose
deno task cf test packages/patterns/keyed-collections/main-v1.test.tsx --verbose
deno test packages/patterns/keyed-collections/latest-by-count-delta-v1.test.ts
deno test packages/patterns/keyed-collections/keyed-collection-v1.test.ts packages/patterns/keyed-collections/view-plan-executor-v1.test.ts packages/patterns/keyed-collections/view-plan-parity-v1.test.ts
deno run -A packages/patterns/keyed-collections/diagnose.ts --programs=main-v1.tsx --votes=20
deno run -A packages/patterns/keyed-collections/diagnose.ts --votes=100,500
deno run -A packages/patterns/keyed-collections/diagnose.ts --modes=bulk --votes=1000,5000
```

See `PERF.md` for the array-aggregate, manual indexed-aggregate, reusable v1
helper, and SQLite-pushdown numbers.
