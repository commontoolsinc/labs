Runner Test Plan

- Goal: Validate behavioral specs for Cell, Data Updating & Links, Schema,
  Scheduler, Runner, Builder, and Transactions using unit and integration
  tests. Use existing tests in packages/runner/test as inspiration and
  expand to cover edge cases called out in these specs.

How To Run

- All: `deno task test`
- Single file: `deno test packages/runner/test/<file>.ts`
- Type checks: `deno task check`

Test Structure

- Unit tests (fast, focused): exercise a single module (e.g., link resolution,
  diff normalization, schema transformation).
- Integration tests (recipe-level): run full recipes through the Runner to
  validate process cell lifecycle, node instantiation, scheduling, and
  persistence flows.

Coverage Map (existing tests to learn from)

- Cells: `cell.test.ts`, `nested_cell_array.test.ts`
- Data Updating & Links: `data-updating.test.ts`, `link-utils.test.ts`,
  `link-resolution.test.ts`, `path-utils.test.ts`, `traverse-utils.test.ts`
- Schema: `schema.test.ts`, `schema-lineage.test.ts`, `schema-to-ts.test.ts`,
  `opaque-ref-schema.test.ts`
- Scheduler & Reactivity: `scheduler.test.ts`, `reactive-dependencies.test.ts`
- Runner & Recipes: `runner.test.ts`, `recipe.test.ts`, `recipes.test.ts`,
  `recipe-binding.test.ts`, `function-cache.test.ts`, `module.test.ts`
- Storage & Transactions: `storage.test.ts`, `storage-subscription.test.ts`,
  `journal.test.ts`, `transaction.test.ts`,
  `transaction-notfound.test.ts`, `push-conflict.test.ts`,
  `provider-reconnection.test.ts`
- Integration flows: `integration/*`, `array_push.test.ts[x]`,
  `basic-persistence.test.ts`, `pending-nursery.test.ts`,
  `reconnection.test.ts`, `sync-schema-path.test.ts`

Test Matrix (what to add/ensure)

1) Cell
- get: follows redirects on leaf; applies defaults; returns immutable views.
- set/send: writes via write-redirect; minimal diffs for primitives/objects.
- update: initializes `{}` when schema allows; per-key writes; rejects non-
  objects.
- push: creates array when missing; ID_FIELD sibling reuse; ID creates entity;
  rejects non-array parent.
- key/asSchema/withTx: child schema resolution; schema swap re-reads; tx
  binding for mutations.
- equals: normalized identity equality.
- sink: re-executes on underlying doc changes (verify by updating a read key).
- getAsLink/getAsWriteRedirectLink: round trip matches normalized link.
- getRaw/setRaw: bypass validation/redirects; sanity-check via storage read.
- getSourceCell: returns undefined for pure literals; returns cell for derived
  references.
- copyTrap: throws on traversal attempts.

2) Data Updating & Links
- normalizeAndDiff basics: primitives, objects (add/update/delete), arrays
  (grow/shrink + `length`), circular references (relative links).
- Links as values: data: link content traversal; non-data links equality vs
  write; link rebasing when content contains links.
- Write-redirect in current: write at destination without overwriting source.
- ID_FIELD sibling reuse within arrays; no reuse when not in array context.
- ID-based object: derived id excludes indices of nested arrays; writes two-
  phase: link set + entity content diff.
- convertCellsToLinks: converts cells/streams/query results; respects toJSON;
  preserves cycles via relative path links.

3) Schema-Driven Reads
- $ref resolution against root; child schema computation along link jumps.
- defaults: objects/arrays (required `{}`/`[]`), primitives, asCell/asStream
  behaviors; immutable annotated values carry toCell/toOpaqueRef symbols.
- anyOf arrays: merge item branches, flatten items.anyOf.
- anyOf objects: merge projections; precedence when a branch is `asCell`.
- Primitives: choose matching branch; fallback to catch-all (type omitted).
- Arrays of links: element link following; copy/splice then write back updates
  `length` and deletes indices.

4) Scheduler & Reactivity
- schedule + subscribe: actions with no reads run; actions with reads blocked
  until dirty; subscriptions created after run.
- dirty invalidation: entity-level dirty marks rerun actions whose reads
  intersect changed paths.
- topological order: writer-before-reader; include downstream actions that read
  writer’s outputs.
- cycle handling: topological sort breaks cycles by lowest in-degree; runs all
  actions exactly once per wave.
- ignoreReadForScheduling: reads with metadata do not create dependencies.
- MAX_ITERATIONS_PER_RUN guard triggers on self-retriggering action.

5) Runner
- process cell lifecycle: first run creates P with TYPE/spell/argument/internal
  and resultRef; second run updates argument without restart; recipe change
  stops and restarts.
- module types:
  - javascript: function caching from string id; wrapper invocation; reads/writes
    detection from bindings; plain result writes vs OpaqueRef result spawning
    a sub-recipe.
  - raw: action factory receives inputsCell/send/addCancel/context; schedule
    with explicit read/write sets.
  - recipe: nested result cell linking.
  - ref: resolves and behaves as resolved module type.
- streams: input resolves to stream marker; event handler registered; on event,
  argument materialization and writes occur; verify scheduling via injected
  event.

6) Builder
- recipe extraction: OpaqueRef inputs, internal cell OpaqueRefs, NodeRefs;
  path/name assignment (argument/internal/result); serialization stable.
- shadow refs: nested/closure recipes captured as ShadowRefs across frames.
- frame enforcement: creating a cell outside lift/handler frame throws.

7) Transactions
- journal records reads/writes with `value` prefix removed; commit publishes
  writes and closes tx; open reads visible within tx.
- syncCell: no-op for `data:` URIs; otherwise requests sync.

Suggested New Tests (missing or to deepen)

- Schema anyOf precedence with mixed cells/objects.
- Circular reference write: relative link back to first occurrence.
- Derived id path context: nested arrays strip indices when deriving entity id.
- Scheduler cycle: A writes X; B reads X and writes Y; C reads Y and writes X;
  verify bounded execution and ordering choice.
- Runner stream handler: end-to-end with event injection and assertion of
  output bindings.
- Builder shadow ref stability: closures carry parent recipe id; extracted
  nodes/names stable across runs.

Test Snippets (patterns)

- Cell sink reactivity
```ts
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

describe("cell sink", () => {
  it("re-executes on dependency change", () => {
    const tx = runtime.edit();
    const c = runtime.getCell(space, { name: "t" }, {}, tx);
    tx.commit();

    let values: any[] = [];
    const cancel = c.sink((v) => { values.push(v); });

    const tx2 = runtime.edit();
    c.withTx(tx2).set({ foo: 1 });
    tx2.commit();

    expect(values.length).toBeGreaterThan(1);
    cancel();
  });
});
```

- normalizeAndDiff ID_FIELD
```ts
const tx = runtime.edit();
const base = runtime.getCell(space, { name: "arr" }, { type: "array" }, tx);
tx.commit();
const tx2 = runtime.edit();
base.withTx(tx2).set([]);
base.withTx(tx2).push({ [ID_FIELD]: "slug", slug: "b", v: 1 });
tx2.commit();
const tx3 = runtime.edit();
base.withTx(tx3).set([
  { [ID_FIELD]: "slug", slug: "a", v: 1 },
  { [ID_FIELD]: "slug", slug: "b", v: 2 },
]);
tx3.commit();
// assert: arr[1] still refers to same entity; entity(b).v == 2
```

- Scheduler topological order
```ts
const a = (tx) => { /* write X */ };
const b = (tx) => { /* read X, write Y */ };
const c = (tx) => { /* read Y */ };
const logA = { reads: [], writes: [addrX] };
const logB = { reads: [addrX], writes: [addrY] };
const logC = { reads: [addrY], writes: [] };
runtime.scheduler.schedule(a, logA);
runtime.scheduler.schedule(b, logB);
runtime.scheduler.schedule(c, logC);
// expect execution order compatible with a -> b -> c
```

Execution Guidance

- Keep unit tests deterministic (no timers/network). For event-based tests,
  inject events via storage notifications or a test harness. When asserting
  reactivity, prefer direct storage writes or cell mutations inside a tx and
  wait for the scheduler to become idle before asserting.

