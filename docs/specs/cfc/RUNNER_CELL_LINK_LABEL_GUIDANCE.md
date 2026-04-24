# Runner Cell/Link Label Guidance

Status: draft. Keep this separate from
[`runner_cfc_implementation.md`](../../plans/runner_cfc_implementation.md)
until the runner agent is ready to promote concrete API and persistence changes
into the plan.

This note records guidance for implementing CFC link-following behavior in
`packages/runner` based on how cells already work in the runtime. The central
point is that the primary semantic unit is a cell view over `(doc, path,
schema)`, not a raw stored sigil link object.

## Main Framing

- A cell read is a view over `(doc, path, schema)` that may transparently follow
  links.
- A stored sigil link is just one possible value at a path.
- CFC work therefore needs two distinct label surfaces:
  - the **cell-view label** for what `get()`, `pull()`, query-result proxies,
    and schema traversal expose after link-following; and
  - the **stored link-field label** for the path where a sigil link is stored as
    data.

Do not collapse those two surfaces into one label story.

## Current Runner Baseline

Relevant code paths:

- `packages/runner/src/cell.ts`
- `packages/runner/src/schema.ts`
- `packages/runner/src/link-resolution.ts`
- `packages/runner/src/data-updating.ts`
- `packages/runner/src/cfc/label-view.ts`
- `packages/runner/src/cfc/prepare.ts`

Current behavior:

- `Cell.get()` goes through `validateAndTransform(...)`, which resolves
  write-redirects and usually resolves the full link chain before materializing
  the value.
- `Cell.getRawUntyped()` resolves links on the way to the final slot, but does
  not resolve the final link value itself.
- `Cell.set()` resolves only through write-redirects and writes into that final
  write target. Ordinary final-slot links are persisted as values, not treated
  as write-through aliases.
- `convertCellsToLinks(...)` and `normalizeAndDiff(...)` are where cell values
  become persisted sigil links.
- `cfcLabelViewForCell(...)` already approximates the label of a linked cell by
  performing a runtime read and merging metadata from the reads that actually
  happened.

This means the runner already behaves as though a cell label should come from
actual dereferenced reads, not just from the queried slot's stored value.

## Guidance

### 1. Do Not Start By Adding A New Storage Primitive

The first implementation does not need a new storage-layer read primitive for
`followRef`.

For conservative downstream confidentiality taint, it is acceptable to treat:

- the read of the link value, and
- the read of the dereferenced target content

as two consumed reads that both taint following writes.

That is already sound for "join all consumed read taint into downstream writes."

### 2. What Still Must Be Preserved

Even if the runtime keeps ordinary read logging, it still needs to preserve the
fact that some target reads happened by following a link chain.

That coupling is needed for:

- computing the label of the dereferenced cell/view itself;
- preserving link-path provenance / additive integrity;
- distinguishing raw-link reads from dereferenced reads;
- and producing useful diagnostics.

So the requirement is not "new primitive op first." The requirement is "some
explicit dereference trace exists."

### 3. Preferred First-Step Representation

Prefer a lightweight dereference trace emitted by `resolveLink(...)` or a nearby
wrapper over reads.

Examples of acceptable shapes:

- metadata on the target read that records followed link hops;
- a side trace captured in transaction-local CFC state;
- or another explicit resolution trace consumed by cell-label and prepare logic.

If a future cleanup introduces an explicit `followRef` activity kind, treat that
as a representation improvement, not as a prerequisite.

## Label Semantics To Implement

### Cell-View Label

Use this surface for `get()`, `pull()`, query-result proxies, traversal, and
other APIs that expose dereferenced cell content.

Rules:

- Include the labels of reads actually consumed to materialize the value.
- When a link hop is followed, include both:
  - the stored link-slot observation, and
  - the target value observation reached through that hop.
- If a dereference trace is available, use it to preserve link-path provenance
  and endorsement-style integrity instead of treating link and target as fully
  unrelated reads.
- Cross-space dereference should remain conjunctive in practice: the resulting
  cell-view label must reflect both the source-side link relationship and the
  target-side content read.

### Stored Link-Field Label

Use this surface for the path that stores a sigil link as data, including raw
reads such as `getRawUntyped()` at the final slot.

Rules:

- Label the field as "this path references that target," not as an inline copy
  of target bytes.
- Preserve source-cell confidentiality/integrity strongly enough that reading
  the field reflects the referenced source and link relationship.
- Add link-local endorsement integrity for the act of storing/selecting that
  reference.
- Do not pretend that reading the stored link field is the same as reading the
  dereferenced target content.

## Important Distinction

Independent reads are enough for conservative write taint, but they are not
enough by themselves for all runner needs.

What independent reads miss:

- a label for the dereferenced cell/view as a first-class result;
- link-specific integrity/provenance;
- a clean distinction between `getRawUntyped()` and `get()`;
- and good diagnostics about why a value is tainted.

So:

- for write-taint soundness, independent reads are acceptable;
- for cell-view labeling and link-path provenance, preserve dereference
  structure explicitly.

## Recommended Implementation Order

1. Add dereference trace plumbing around `resolveLink(...)`.
2. Add a helper that computes a cell-view label from:
   - stored metadata on consumed link slots,
   - stored metadata on consumed targets,
   - and the dereference trace.
3. Add a write-policy input for persisted link writes.
4. Emit that input at the point where `normalizeAndDiff(...)` actually decides
   to persist a link value.
5. Teach `prepare.ts` to derive persisted labels for link-valued paths from:
   - the source cell label / source metadata,
   - link-local endorsement integrity,
   - and any explicit schema on the stored link when available.
6. Keep enforcement conservative if source metadata is missing: fail closed in
   enforcing modes rather than silently treating the link as unlabeled public
   data.

## Where To Emit Link-Write Provenance

Do not emit link-write provenance from `convertCellsToLinks(...)`.

That helper runs too early. Some values that look like links there are later
collapsed into snapshots by `normalizeAndDiff(...)`, especially around
same-document parent/self cases.

The correct emission point is where the diffing layer has decided that the
persisted value at the target path will actually be a link.

## Non-Goals And Pitfalls

- Do not rewrite `runner_cfc_implementation.md` from this note.
- Do not require every stored link to carry schema before attaching CFC labels
  to link-valued paths.
- Do not treat ordinary final-slot links as write-through aliases. Only
  write-redirect behavior should follow that path for writes.
- Do not collapse `getRawUntyped()` and `get()` into the same label semantics.
- Do not rely only on final-target reads if you need link-path provenance or
  additive integrity.

## Suggested Tests

- Reading a cell through a link taints the resulting cell-view label from both
  the link slot and the dereferenced target.
- Raw final-slot reads of a stored link differ from dereferenced reads of the
  same slot.
- Two different links to the same target yield the same target-content taint but
  different integrity/provenance when link endorsements differ.
- Writing a cell into another doc persists CFC metadata for the stored link path
  even when the sigil link omits schema.
- Cross-space linked reads pull target-side metadata into the resulting
  cell-view label.
- Link values collapsed to snapshots in `normalizeAndDiff(...)` do not persist
  link-style provenance metadata.
- `cfcLabelViewForCell(...)` continues to reflect labels behind linked cells and
  can later consume the dereference trace when available.

## Promotion Criteria

- The runner can explain, for a dereferenced cell read, which link hops and
  target reads contributed to the final label.
- Link-valued stored fields receive persisted CFC metadata even when they were
  written from cells rather than from schema-annotated inline values.
- `getRawUntyped()` and `get()` have intentionally different CFC behavior at the
  final slot.
- The implementation remains conservative for downstream write taint even before
  any future cleanup introduces an explicit `followRef` activity kind.
