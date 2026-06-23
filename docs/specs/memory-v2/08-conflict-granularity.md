# Commit-conflict granularity

This note describes how Memory v2 decides whether a committing transaction's
**reads** conflict with concurrent **writes**, and the three refinements that
make distinct, non-interacting operations stop colliding.

## The model

A commit carries a read-set (`confirmed` / `pending`) and a set of write
operations. On commit the server checks, for each read, whether any write with a
higher `seq` on the same entity invalidates it (`findConflictSeq`). The check is
two-tier:

- **Tier-1** (`set` / `delete`): path-**blind**. A whole-document set or delete
  conflicts with *any* read of that entity — the document the reader observed no
  longer exists in the form it saw.
- **Tier-2** (`patch`): path-**aware**. A patch conflicts with a read only if a
  touched path overlaps the read path.

The bug this note addresses: two writers touching **different keys of the same
container** (e.g. `votes.alice` and `votes.bob`) collided at Tier-2 even though
neither logically depended on the other, exhausting the retry budget and dropping
writes under contention. Three independent sources of spurious dependencies
produced that collision; each is removed at its own seam.

## 1. Recursive reads use leaf-only touched paths

`touchedPathsForPatch` historically injected a patch's **parent** path for
`add`/`remove`/`move`, so a key add to `["value","map","k"]` also "touched"
`["value","map"]`. For a **recursive** read that parent path is:

- **redundant** — bidirectional `pathsOverlap` already matches a container reader
  (`["value","map"]`) against the leaf write (`["value","map","k"]`), because the
  container read is a *prefix of* the leaf; and
- **harmful** — the injected parent also prefix-matches every disjoint **sibling**
  reader (`["value","map","j"]`, a distinct-key writer's own-key/diff and
  link-resolution reads), whose value did not change.

`patchOverlapsRead` now uses **leaf-only** touched paths (`touchedLeafPathsForPatch`)
— the same discipline already applied to the scheduler reader-dirty index
(CT-1623). Same-key writes still conflict (the leaf exactly matches an own-key
read); whole-container and keyset readers still conflict (their read prefixes the
leaf). Only the spurious sibling match is dropped. The one shape where leaf-only could
miss a conflict — an array **index shift** — never arises from the runner; see
[Array writes and the leaf-only matcher](#array-writes-and-the-leaf-only-matcher)
below.

### Array writes and the leaf-only matcher

Leaf-only matching has exactly one blind spot: an `add`/`remove`/`move` whose
target is an **array index**. Such an op *shifts* sibling elements, but its leaf
path captures only the touched index — so a recursive reader of a shifted sibling
(`arr/5` after an insert at `arr/2`) would neither conflict on commit nor
re-trigger via the (also leaf-only) reader-dirty index. That would be a silent
stale read.

This is safe because **the runner never emits an indexed-array
`add`/`remove`/`move`**. `buildArrayPatchCandidates`
(runner `storage/v2-transaction.ts`) encodes every array change as one of three
shapes, all of which both the leaf-only commit matcher and the leaf-only
reader-dirty index handle conservatively:

- **in-place element change** → `replace` at `arr/i` (leaf-exact; no shift);
- **tail grow / shrink** → a `splice` whose path **is the array** (`arr`), which
  prefix-matches every index reader below it; and
- **messy cases** (mid-array presence change, sparse growth) → a whole-array
  `replace` at `arr` (same conservative coverage).

`move` is never generated at all. So an array index shift always reaches the
engine as a `splice` or whole-array `replace` on the array path — never as an
indexed structural op.

Because the safety of leaf-only matching *depends* on this — and it is a
whole-system property of the producer rather than something the engine enforces —
it is guarded two ways:

- a runtime assertion, `assertNoIndexedArrayStructuralOps`, runs at the sole
  patch-generator chokepoint (`buildPatchOperation`) and throws if a future
  regression ever emits an indexed-array `add`/`remove`/`move`; and
- a generator test (`packages/runner/test/memory-v2-native-commit.test.ts`,
  "v2 patch generator never emits indexed-array add/remove/move") drives every
  array idiom through real cell writes and asserts the emitted ops.

The engine still *accepts* indexed-array structural ops — they remain
protocol-legal (the nonRecursive matcher handles them via parent injection, and
stacked-commit tests exercise committed `move`s). The guarantee is narrower and
lives on the producer side: the **runner** never emits one, which is what keeps
the recursive leaf-only matcher free of false-negatives in production.

## 2. Shape (nonRecursive) reads conflict only at-or-above the read path

A read can be **shape-only**: the reader observed a container's key-set /
existence but not the deep values beneath it (QueryResultProxy creation,
`ownKeys`, `getOwnPropertyDescriptor`, `has`, array `length`). Such reads are now
tagged `nonRecursive` and carried through to the engine (previously the flag was
stripped at the client boundary).

For a nonRecursive read, `patchOverlapsNonRecursiveRead` conflicts only with a
write touching the read path **itself or an ancestor** — `isPrefixPath(touched,
readPath)`. This keeps the **parent-injecting** `touchedPathsForPatch`, so a key
`add`/`remove` (which injects the container's path) still conflicts with a keyset
reader — the shape it observed changed. A disjoint deep-value `replace` strictly
*below* the read path no longer over-conflicts. The shallow predicate is a strict
subset of the recursive one, so it can only remove spurious conflicts, never miss
a genuine one.

## 3. asCell reference-resolution reads are not value dependencies

Materializing an `asCell` argument **resolves a reference**: it follows the arg's
write-redirect and reads the target container's *shape* to construct the `Cell`.
That read does not consume a value — the holder depends on the referent only when
it reads **through** the cell in its body. Such reference-resolution reads are
tagged `excludeReadFromConflict` at the traversal seam
(`traverseObjectWithSchema`, gated on `hasAsCell(propSchema)`), and
`buildReads` drops them from the conflict set when they are `nonRecursive`. They
remain in the journal for reactivity. A **by-value** argument (`hasAsCell` false)
is a genuine dependency and is never marked; the gate ensures by-value scalar
reads — which are also recorded `nonRecursive` — keep their dependency.

## Composition

The three are orthogonal and compose at one matcher:

| read kind | matched by | touched paths |
|---|---|---|
| recursive value read | `patchOverlapsRead` | leaf-only |
| nonRecursive shape read | `patchOverlapsNonRecursiveRead` | parent-injected |
| asCell reference-resolution read | excluded from conflict | — |

Net effect: disjoint-key writers no longer collide; same-key RMW, whole-container
reads, keyset readers, and genuine value dependencies all still conflict.

## Related history

This supersedes / composes prior spike PRs:

- **#4199** (exclude a write's own machinery reads): superseded by §1 — fixing the
  matcher (no read deletion) avoids #4199's cross-space regression and preserves
  same-key RMW conflicts.
- **#4200** (honor nonRecursive shape reads): incorporated as §2.
- **#4210** (reactive computes don't immediately re-queue on conflict): orthogonal
  (reduces retry-storm cost rather than conflict count); lands independently.

Out of scope (separate lever): whole-document reads by output-derivation computes
that re-derive and replace a shared result document, and genuine shared-leaf
read-modify-write (array push) — neither is a granularity artifact.
