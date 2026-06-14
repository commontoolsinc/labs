# 07 — Op Views and Anchored Annotations (Future Work)

This section describes a future extension for collaborative fields whose readers
may need more than the materialized value. The immediate motivating case is
collaborative text editing, but the model is intended to be generic enough for
other field types that use operation-based synchronization.

Phase 1 of Memory v2 returns materialized entity values. That remains the
default. This document adds a second dimension: some field paths may also expose
operation-oriented projections and storage-derived label side-data.

This is future work. It should land only after the branch/conflict model is
stable enough to support rebasing or transform-based write classes.

---

## 7.1 Goals

- Preserve the original signed operation payload submitted by the client.
- Expose a canonical integrated operation stream for readers that need it.
- Keep the ordinary materialized read path as the default for most queries.
- Let storage return effective label side-data together with materialized
  collaborative values when that side-data depends on operation history.
- Keep user-level annotations as ordinary application data anchored to content,
  rather than mixing them into the system-owned label side-data plane.

## 7.2 Non-Goals

- This document does **not** redesign the full metadata or label model.
- This document does **not** make every JSON path operation-addressable.
- This document does **not** require the editor integration layer to compute
  authoritative labels, rebases, or provenance.
- This document does **not** standardize a single editor codec. Multiple codecs
  may exist if the server can validate and transform them.

---

## 7.3 Why Materialized Reads Are Not Enough

For ordinary `set` and `patch` writes, the stored operation list is usually only
interesting as a means to reconstruct the current value. Most readers want the
materialized state, not the individual ops.

Collaborative editors are different:

- the client often submits an editor-native operation payload, not just a new
  string
- the server may need to transform or rebase that payload before integrating it
- another client may want the canonical integrated ops, not only the final
  string
- storage-derived label side-data for the current text may depend on which
  operations contributed to which ranges

The existing v2 commit infrastructure already persists the original signed
command and authorization separately from the semantic seq-addressed commit
record. That means Memory v2 already retains part of the "submitted view". The
missing piece is a query model that can expose it cleanly, alongside the
integrated and materialized views.

---

## 7.4 Three Projections

Collaborative fields introduce three distinct projections over the same logical
history:

### 7.4.1 Submitted View

The **submitted view** is the operation payload exactly as signed and sent by
the client. It captures author intent and protocol provenance.

Properties:

- Ordered by canonical commit order on the branch where the write was accepted.
- Payload is preserved exactly as submitted.
- Readers can join it back to commit records and, when present,
  invocation / authorization records.
- Submitted ops are not assumed to be directly replayable on top of the current
  document state.

### 7.4.2 Integrated View

The **integrated view** is the canonical operation stream that the server
actually applied after any transform, rebase, or normalization.

Properties:

- Branch-scoped and replayable.
- Suitable for editor clients that synchronize by receiving remote ops.
- May differ from the submitted view even when the resulting materialized value
  is the same.
- Must be stable enough to support incremental subscription resume.

### 7.4.3 Materialized View

The **materialized view** is the current field value produced by replaying the
integrated history (or loading a snapshot/checkpoint).

For collaborative text-like values, the materialized view MAY also include
storage-derived label side-data. That side-data remains storage-owned. The
editor may render it, but the editor does not author it.

The default query semantics remain materialized reads.

---

## 7.5 Collaborative Field Capability

Operation-oriented projections should be opt-in per field path. The query layer
must not assume that arbitrary JSON values support submitted or integrated op
views.

Some capability declaration is required to bind a field path to:

- an operation codec
- a transform / rebase engine
- a materializer
- an annotation-mapping strategy for anchored application annotations

The exact declaration mechanism is future work. It may live in schema metadata,
server configuration, or both. Regardless of the syntax, the server MUST know
which paths are collaborative before accepting op-based writes or op-view
queries on them.

Illustrative shape:

```typescript
type OpCodecId = string; // e.g. "text-ot@1", "prosemirror-step@1"

interface CollaborativeFieldCapability {
  id: EntityId;
  path: ReadPath;
  codec: OpCodecId;
}
```

This is intentionally minimal. It identifies the field, not the full editor
contract.

---

## 7.6 Write Path Changes

Phase 1 only defines `set`, `patch`, and `delete`. Collaborative fields need a
new write class whose payload is the original submitted op batch for a declared
field path.

Illustrative extension:

```typescript
interface ApplyOpOperation {
  op: "apply-op";
  id: EntityId;
  path: ReadPath;
  codec: OpCodecId;
  payload: JSONValue; // codec-defined submitted op batch
}

type Operation =
  | SetOperation
  | PatchWriteOperation
  | DeleteOperation
  | ApplyOpOperation;
```

Semantics:

1. The client submits only the original editor payload.
2. The server validates that the target path is a declared collaborative field.
3. The server resolves the branch/path version and performs any required
   transform or rebase.
4. The server assigns stable identifiers/cursors for the accepted op batch.
5. The server persists enough information to reconstruct both the submitted and
   integrated views.
6. The server updates the materialized field value and any derived side-data
   checkpoints atomically with the commit.

The server MUST NOT trust client-supplied integrated ops, client-supplied label
side-data, or client claims about which spans were affected.

### 7.6.1 Receipts

Receipts for op-based writes need more than `{ hash, seq }`. At minimum, the
client needs a canonical cursor for resume and a way to correlate the submitted
payload with the integrated result.

Illustrative receipt extension:

```typescript
interface ApplyOpResolution {
  id: EntityId;
  path: ReadPath;
  codec: OpCodecId;
  version: number; // path-local integrated version after apply
  opIds: string[]; // stable ids for accepted logical ops
}
```

The exact receipt shape is future work, but op-based writes need some path-local
versioning surface in addition to the entity-level `seq`.

---

## 7.7 Storage Model Changes

The current storage model is fact-centric and replay-oriented. Collaborative
fields add three storage requirements.

### 7.7.1 Queryable Submitted Payloads

The original signed payload already exists in commit/invocation storage. Future
work must make it queryable without requiring ad hoc joins through raw UCAN
objects for every read.

This does **not** require duplicating the full signed command into every fact.
It does require an indexed path from:

- entity id
- field path
- branch / seq / commit

to the original submitted op payload.

### 7.7.2 Canonical Integrated Op Log

Integrated ops need their own queryable, replayable history. That history may be
stored directly in facts, in an adjunct op log keyed from facts/commits, or in
another storage shape with equivalent integrity guarantees.

Required properties:

- branch-scoped ordering
- stable op ids or equivalent durable cursors
- replay without consulting client-local state
- efficient incremental reads for subscriptions and resume

### 7.7.3 Collaborative Snapshots / Checkpoints

For large collaborative fields, replaying the full integrated op log on every
read is too expensive. Storage therefore needs checkpoints that can restore:

- the materialized field value
- any storage-derived label side-data associated with that materialized value
- the path-local integrated version used as the checkpoint base

This is analogous to entity snapshots in §01/§02, but field-local and
projection-aware.

---

## 7.8 Query Changes

The query model needs an explicit projection selector for collaborative fields.
The key point is that "return me the current value" and "return me the
integrated ops since version N" are different queries.

Illustrative request shape:

```typescript
type ProjectionKind =
  | "materialized"
  | "submitted-ops"
  | "integrated-ops";

interface ProjectionRequest {
  id: EntityId;
  path: ReadPath;
  kind: ProjectionKind;
  fromVersion?: number; // for incremental op reads
  includeSideData?: {
    labels?: boolean;
  };
}
```

Semantics:

- `materialized` returns the current field value.
- `materialized + includeSideData.labels` may return storage-derived label
  side-data for that field when available.
- `submitted-ops` returns original submitted payloads in canonical commit order.
- `integrated-ops` returns canonical applied ops in integrated order.

The protocol should reject op-view queries for undeclared paths rather than
falling back silently to materialized reads.

### 7.8.1 Subscriptions

Subscriptions need the same projection distinction:

- a materialized subscription emits updated field values
- an integrated-op subscription emits accepted integrated ops after a cursor
- a submitted-op subscription is mainly for audit/debug tooling and may be less
  common in product paths

The current entity-level seq cursor mechanism is not sufficient on its own for
op-view subscriptions. Collaborative fields need a path-local resume cursor or
version in addition to the entity-level `seq`.

### 7.8.2 Graph Queries

Phase 1 graph traversal is materialized and schema-driven. Op-view graph queries
should be deferred initially. They add difficult questions around topology,
fan-out, and mixed projections inside one traversal result.

The first incremental step should be:

- direct field queries support `materialized`, `submitted-ops`, and
  `integrated-ops`
- graph queries remain materialized-only until a compelling use case exists

---

## 7.9 Label Side-Data on Materialized Reads

This document assumes that effective labels remain part of system-controlled
side-data, not editor-controlled content.

For collaborative text-like materialized reads, storage MAY return label
side-data whose shape includes range-oriented information over the current
materialized content. This is a derived projection, not a new user-authored
value.

Properties:

- The label side-data is derived from committed history.
- Clients may render it but do not author it directly.
- The authoritative computation happens in storage/query code, not in the editor
  component.
- The side-data belongs to the materialized projection. It is not a substitute
  for submitted or integrated op views.

This document intentionally does not define the label language, label algebra,
or redaction semantics. It only reserves the need for range-oriented side-data
when the materialized value is sequence-like.

---

## 7.10 User-Level Anchored Annotations

User-level annotations are a separate plane from storage-owned label side-data.

Examples include:

- review notes
- agent instructions
- bookmarks
- highlights
- other application-defined anchored records

These should remain ordinary application data stored in entities/documents with
their own schemas. What makes them special is not their payload shape, but that
they are anchored to a collaborative field.

Properties:

- The annotation payload is ordinary system data like any other record.
- The anchor targets a declared collaborative field path plus a logical range or
  position within that field.
- Anchors must map through integrated ops using the field's mapping strategy.
- Annotation payloads are **not** folded into the system-owned label side-data.

Illustrative shape:

```typescript
interface AnchoredAnnotation {
  target: {
    id: EntityId;
    path: ReadPath;
  };
  anchor: JSONValue; // codec-defined anchor/range payload
  data: JSONValue; // application-defined payload
}
```

This keeps the language generic. The system does not privilege "comments" over
other annotation types.

---

## 7.11 Branching and Merge Semantics

Integrated op history is branch-local. The same submitted payload may integrate
differently on different branches if rebased against different prior history.

Therefore:

- the submitted view is tied to the original accepted commit payload
- the integrated view is tied to a branch-local replay order
- the materialized view is derived from the integrated branch-local history

Merging branches with collaborative fields requires more than ordinary
path-overlap detection. The merge process must either:

- replay submitted ops through the target branch's transform engine, or
- materialize a merge result and record new integrated ops that explain it

This work should remain deferred until the base branch/merge model in §06 is
implemented end to end.

---

## 7.12 Minimum Protocol/Storage Delta

The smallest coherent future increment is:

1. Add a collaborative field capability declaration.
2. Add an op-based write class for declared field paths.
3. Add a direct-field query API with explicit projection selection.
4. Add a path-local version/cursor for op subscriptions and resume.
5. Add queryable submitted-payload access and canonical integrated-op storage.
6. Add collaborative checkpoints for materialized value + derived label
   side-data.
7. Keep user-level anchored annotations as separate ordinary data.

Anything smaller risks hiding the distinction between submitted, integrated, and
materialized history without actually removing it.

---

## 7.13 Open Questions

- Should integrated ops reuse `PatchWrite` with richer `PatchOp` variants, or
  should collaborative writes get a distinct fact/write class?
- Should the canonical integrated representation preserve editor-native payloads
  verbatim, normalize into an internal IR, or store both?
- How much provenance should materialized reads expose beyond label side-data:
  op ids only, commit refs, or richer contributor spans?
- Should anchored annotations subscribe through the same projection channel as
  the field they target, or through ordinary entity subscriptions plus local
  anchor mapping?
- What is the right checkpoint granularity for large documents with many
  collaborative fields in one entity?

These questions should be resolved with the concrete editor integrations in
view, but the projection split in this document should remain stable.
