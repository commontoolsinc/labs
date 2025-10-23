# Graph Snapshot Schema

> **Status:** This work is **deferred to Phase 2** (see `rollout-plan.md` and
> `overview.md`). The snapshot format described here will be implemented as part
> of the `process` metadata work mentioned in the rollout plan (lines 54-61).

## Motivation

- `Runner.setupInternal` currently stores recipe metadata inside the process
  cell (`TYPE`, `argument`, `internal`, `resultRef`). We plan to deprecate
  `TYPE` while still persisting the originating program reference (rename the
  `spell` field to `pattern`). The runtime still lacks a persisted view of the
  concrete nodes it instantiated.
- `instantiateNode` performs alias gymnastics through
  `unwrapOneLevelAndBindtoDoc` so nested recipes and closures work. A snapshot
  that records the resolved nodes makes this machinery obsolete: future runs can
  reconstruct bindings directly from the snapshot.
- Persisting a snapshot on the result cell lets the runtime answer "what does
  this graph look like" without re-running the factory, simplifying rehydration
  and teardown.

## Relationship to Rollout Plan

This spec describes the implementation for tasks in `rollout-plan.md` lines
54-61:

- Write metadata into result cell including `source` (from context) and
  `process` metadata
- The `process` field contains the graph snapshot described in this document,
  including:
  - The `Module` (which includes the `Program` as link using `cid:hash`)
  - Created cells with links to module and/or schema
  - History of previously used schemas (P2 for safe updating)

## Snapshot Envelope

Store an additional `process` payload on the result cell alongside the existing
`value`, `source`, and renamed `pattern` metadata. The payload is versioned to
allow future format changes.

```ts
interface GraphSnapshotV1 {
  version: 1;
  program?: RuntimeProgram;
  generation?: number; // Incremented each time the runtime rebuilds the graph
  nodes: Array<ReactiveNodeSnapshot | EventHandlerSnapshot>;
}

interface ReactiveNodeSnapshot {
  module: ReactiveModuleDescriptor;
  inputs: Record<string, Binding>;
  output?: CellLink; // Optional; some modules only read
  argumentSchema?: JSONSchema;
  resultSchema?: JSONSchema;
}

interface EventHandlerSnapshot {
  module: EventHandlerDescriptor;
  inputs: Record<string, Binding>;
  stream: CellLink; // Event stream destination
  argumentSchema?: JSONSchema;
}

type Binding = CellLink | JSONValue | Record<string, Binding> | Array<Binding>;

type ReactiveModuleDescriptor =
  | {
    type: "ref";
    ref: string;
    argumentSchema: JSONSchema;
    resultSchema?: JSONSchema;
  }
  | {
    type: "javascript";
    implementation: string | { file: string; export: string };
    argumentSchema: JSONSchema;
    resultSchema?: JSONSchema;
    metadata?: Record<string, JSONValue>;
  };

type EventHandlerDescriptor = ReactiveModuleDescriptor & { handler: true };
```

- Notes:

  - Only nodes are serialized; cells and links are implied by the cell links
    used in `inputs`, `output`, or `stream`.
  - `CellLink` reuses the normalized link format the runtime already
    understands.
  - `Binding` supports nested structures so aliases into deeply nested inputs
    are preserved without separate link tables.
  - Optional `argumentSchema`/`resultSchema` on the node let nodes further
    constrain or specialize module signatures without mutating the module
    definition.
  - `program` points to the main compiled artifact so tooling can correlate
    modules with source files (see `packages/runner/src/harness/types.ts` for
    `RuntimeProgram`).
  - Descriptor-level `argumentSchema` values MUST describe array/prefix-array
    schemas so reactive nodes can express tuple-style inputs used by lifts and
    handlers.

## Generation Flow (Phase 2)

> **Note:** This describes future implementation work after Phase 1 type
> unification is complete.

1. When `Runner.startWithTx` iterates nodes during lift/handler execution,
   instrument each instantiation to record:
   - The resolved module descriptor, including implementation reference
   - Normalized input links (already resolved since cells have concrete causes
     from Phase 1 work)
   - Either an output link (for reactive nodes) or a stream link (for event
     handlers), whichever applies
   - Optional argument/result schemas attached by the builder
2. Compute the final snapshot object, attach it to
   `resultCell.withTx(tx).setMetadata("process", snapshot)` (note: using
   `process` not `graph` to match rollout plan), and persist it in the same
   transaction that finishes setup

## Rehydration Strategy (Phase 2)

> **Note:** Deferred to Phase 2 implementation.

- On `Runner.setupInternal`, if a prior snapshot exists, load it before
  unpacking defaults. The runtime can:
  - Reattach scheduler subscriptions by walking the nodes, reusing modules whose
    implementation reference matches
  - Rehydrate handler streams directly from their stored links
- When a handler or lift causes a graph to rebuild, diff the previous and new
  node lists. Nodes that disappear are torn down by following their stored
  output/stream links. Nodes with matching descriptors can reuse their existing
  cells

## Teardown and Diffing (Phase 2)

> **Note:** Deferred to Phase 2 implementation.

- Nodes uniquely define the dependencies; links are inferred from the cell links
  embedded inside each snapshot entry. Diffing node descriptors is sufficient to
  drive teardown
- Maintain a monotonic `generation` counter on the snapshot. When a handler
  triggers rehydration, increment the counter so logs can correlate actions with
  rebuilds

## Outstanding Questions

- Should snapshots include scheduler bookkeeping (e.g., dependency edges, last
  run timestamps) or should that remain derived at runtime?
- How do we store large schemas efficiently? Option: store a content hash in the
  snapshot and persist the full schema in a shared manifest keyed by hash.
- What is the cleanest way to encode the `pattern` reference alongside the
  snapshot so older runtimes can ignore it while newer ones rely on it?
