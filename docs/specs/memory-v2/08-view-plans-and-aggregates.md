# 08 — View Plans and Aggregates (Future Work)

This section captures the runtime/backend direction learned from the
`packages/patterns/keyed-collections` proof of concept. The POC keeps the author
experience cozy by exposing pattern-layer helpers, while also attaching a closed
`ViewPlan@1` sidecar and an executable `latestByCountDelta@1` semantic operation
that future runtime and storage backends can lower.

Phase 1 of Memory v2 returns ordinary materialized entity values. That remains
the default. This document adds an opt-in declaration path for helper-authored
views such as ordered keyed collections, latest-by records, group-by buckets, and
count-by-choice aggregates.

This is future work. The current implementation is the pattern-local POC and its
pure reference executors; Memory v2 does not yet consume `ViewPlan@1`.

---

## 8.1 Goals

- Keep the primary authoring API cozy: users call helpers such as
  `keyedCollection(...)`, not SQL or low-level indexes.
- Let advanced helper authors declare closed, typed view semantics that the
  runtime can validate before choosing an execution backend.
- Preserve one semantic contract across the cell fallback, runtime-maintained
  indexes, and SQLite pushdown.
- Support incremental aggregate maintenance for hot interactive views without
  exposing raw storage internals to patterns.
- Give the runtime enough structure to choose between small in-memory views,
  durable keyed materializations, and backend pushdown for large event histories.

## 8.2 Non-Goals

- This document does **not** expose raw SQLite, arbitrary SQL, or general query
  planning as the pattern authoring surface.
- This document does **not** make `ViewPlan@1` a shipped Memory v2 protocol yet.
- This document does **not** replace ordinary materialized reads or schema-based
  graph traversal.
- This document does **not** define every aggregate; it starts with the closed
  shapes proven by the POC.
- This document does **not** solve concurrent commutative write conflicts by
  itself. It defines the semantic operations that a later conflict-aware storage
  layer can apply atomically.

---

## 8.3 Authoring Model

Pattern authors should see a small helper, not a storage engine:

```typescript
const votes = keyedCollection({ key: "voter" });
const tallies = votes.latestBy("voter")
  .groupBy("optionId")
  .countBy("choice", ["red", "yellow", "green"]);
```

The helper owns the current fallback cells and publishes a view plan describing
the same semantics:

```typescript
interface ViewPlanV1 {
  version: "commonfabric.view-plan@1";
  name: string;
  source: ViewPlanSourceV1;
  steps: readonly ViewPlanStepV1[];
  fallback: { mode: "cell-helper" | "computed-snapshot"; helper: string };
  eligibleExecution: readonly (
    | "cell-fallback"
    | "runtime-maintained"
    | "sqlite-pushdown"
  )[];
  notes: readonly string[];
}
```

The important boundary is that the plan is declarative and closed. Advanced
users can write new cozy helpers by composing supported steps, but they do not
receive arbitrary access to storage tables or query strings.

---

## 8.4 Supported Initial Plan Shapes

The POC validates two starting shapes.

### 8.4.1 Ordered keyed values

```text
source -> keyBy(fields) -> orderBy($insertion, $key) -> materialize(orderedValues)
```

Semantics:

1. Compute a stable encoded key from declared fields.
2. Reject duplicates or replace the row by key, depending on the conflict
   policy.
3. Preserve insertion order for first-seen keys.
4. Materialize ordered rows, keyed storage, order, and count.

### 8.4.2 Latest rows and count buckets

```text
source
  -> latestBy(fields, conflict)
  -> groupBy(fields)
  -> countBy(choiceField, choices)
  -> materialize(latestRowsAndCountBuckets, lowering=latestByCountDelta@1)
```

Semantics:

1. Keep at most one latest row per encoded latest key.
2. For each accepted row, derive the old projection and new projection.
3. Evaluate `latestByCountDelta@1` to produce row-count and bucket deltas.
4. Apply those deltas atomically to the latest-row index and count buckets.
5. `toggle-when-same` removes the row when the same latest key/group/choice is
   submitted again; `replace-by-key` updates the latest row without changing
   counts when the projection is unchanged.

---

## 8.5 Semantic Operation: `latestByCountDelta@1`

The first closed aggregate operation is intentionally narrow:

```typescript
interface LatestByCountDeltaV1<Row, Choice extends string> {
  kind: "latestByCountDelta@1";
  latestKey: string;
  previous?: { row: Row; group: string; choice: Choice };
  next?: { row: Row; group: string; choice: Choice };
  choices: readonly Choice[];
  conflict: "replace-by-key" | "toggle-when-same";
}
```

It evaluates to one of the valid aggregate shapes:

- insert: `+1` row count and `+1` target bucket;
- update within a group: `0` row count, `-1` old choice, `+1` new choice;
- move between groups: `0` row count, `-1` old group bucket, `+1` new group
  bucket;
- same-projection replace: update latest row, no count or bucket delta;
- remove/toggle: `-1` row count and `-1` previous bucket;
- missing remove: no-op.

No runtime/backend lowering may invent partial states outside this set. If a
fallback cannot prove the previous projection, it must fail closed or invoke an
explicit repair/rebuild path; it must not bump one bucket without the matching
row-count or old-bucket delta.

---

## 8.6 Runtime Lowering Model

The runtime should treat a view plan as a contract plus an execution preference,
not as an author-controlled storage program.

1. Validate the plan shape, step order, fields, conflict policy, outputs, and
   fallback.
2. Check the declared source cells/entities and schema permissions.
3. Choose the highest safe eligible tier:
   - `cell-fallback`: today's helper-owned cells;
   - `runtime-maintained`: runtime-owned keyed materializations and aggregate
     cells;
   - `sqlite-pushdown`: storage-owned tables/indexes/queries for large event
     histories.
4. Execute the same semantic operation for every tier.
5. Surface the same materialized outputs to readers regardless of tier.

The cell fallback remains important even after runtime support lands. It is the
portable semantics, a migration path, and a debug/reference implementation.

---

## 8.7 Storage Model Implications

Runtime-maintained or pushed-down views need storage-owned metadata tying the
view to source history:

- plan id/version and validated plan payload;
- source entity/cell ids and relevant schema paths;
- materialized view entity ids or backend table/index ids;
- dependency cursors sufficient for catch-up and replay;
- fallback mode and repair/rebuild marker.

For SQLite pushdown, the runtime owns table/index/query generation. The pattern
does not receive table names, SQL strings, or direct write access. This mirrors
the SQLite builtin guardrail: storage can use SQLite internally without making
SQLite the public aggregate DSL.

---

## 8.8 Query and Subscription Semantics

View-backed outputs should behave like ordinary materialized reads to consumers:

- one-shot reads return the current materialized view;
- watches include the view output in the session catch-up set;
- invalidation should be as narrow as the view can prove, not whole-database by
  default;
- replay from a checkpoint plus source deltas must produce the same result as
  the pure reference executor.

The query surface may later expose view metadata for diagnostics, but ordinary
pattern composition should consume the materialized output cells/values, not the
view maintenance internals.

---

## 8.9 Security and Capability Boundaries

- Plans are data, not code. The runtime accepts only known versions, steps,
  fields, conflict policies, and lowerings.
- Raw SQL and arbitrary storage table handles are not part of the cozy helper or
  advanced helper-author surface.
- Runtime/backend lowerings must enforce the same read/write capabilities as the
  fallback cells and source entities.
- CFC labels and future per-row/per-column labels must attach to source data and
  materialized outputs; helper-authored plans cannot mint trusted provenance.
- Key encoding and field extraction must be deterministic and prototype-safe.

---

## 8.10 Rollout Sketch

1. Keep the pattern-local helper, `ViewPlan@1` validator, pure reference
   executor, and delta tests green.
2. Add a runtime reference executor behind diagnostics only; compare it against
   helper-maintained cells in tests.
3. Add a runtime-maintained materializer for the closed latest-by/count-by shape.
4. Add backend pushdown for event-log sources, including declared indexes and
   finer invalidation than whole-DB `reactOn`.
5. Add repair/rebuild flows for view state that cannot prove an incremental
   previous projection.
6. Promote the cozy helper API once the same tests pass against at least two
   execution tiers.

---

## 8.11 Open Questions

- Where should durable view-plan metadata live: schema metadata, result-cell
  graph metadata, Memory v2 system entities, or a combination?
- What is the smallest declared-index API needed for SQLite pushdown without
  exposing SQL?
- How should concurrent same-key writes resolve across branches and session
  catch-up?
- Which aggregates beyond `latestBy + countBy` deserve first-class closed
  semantic operations?
- How should CFC labels propagate from source rows into grouped aggregate
  buckets?
