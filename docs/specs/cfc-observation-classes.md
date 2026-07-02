# CFC observation classes (`PathLabelTemplate`) — design

_Epic C, stage C0, of
[`docs/plans/cfc-future-work-implementation.md`](../plans/cfc-future-work-implementation.md).
Spec: `commontoolsinc/specs` `cfc/04-label-representation.md` §4.6.3 (the
primitive read profile) and §4.5.2; the residuals are SC-4 / SC-8 in
[`cfc-spec-changes.md`](./cfc-spec-changes.md). This doc settles the semantics
before C1–C5 land code — the design has real open choices and they should be
written down first._

## 1. Problem

Today one label lives at a path and is consumed identically by every read,
regardless of what the read actually observed. That collapses distinct
observation channels that the spec (§4.6.3) keeps separate — `value`, `shape`
(existence/type), `enumerate` (membership/keys/length/order), `count`,
`followRef` (which reference sits at a slot). Two consequences, both documented
residuals:

- **SC-4 — existence channel.** When a derived label is *replaced* on overwrite
  (§8.12.8 replace-on-overwrite for the `derived` component), the replacement
  also shrinks the label covering **existence**: "this path was once written"
  becomes a public bit. Acknowledged in-code at `prepare.ts` (the derived-clear
  comment near the flow-read exclusion).
- **SC-8 — pointer-identity-at-a-slot.** Reading *which* reference sits at a
  slot without dereferencing it (a `linkResolutionProbe`) observes the link's
  identity, but that observation is currently **excluded** from the flow join —
  so the fact-of-which-element is unlabeled. The `structure` labelMap component
  is only a partial container-shape mitigation.

Both are under-restrictions of a *channel*, not of a value — exactly what
observation classes exist to separate.

## 2. What already exists (the substrate C builds on)

Better than the audit implied — most of the plumbing is present:

- **A provenance axis on the persisted entry.** `LabelMapEntry.origin`
  (`declared` | `link` | `derived` | `structure` | `external-ingest`,
  `packages/runner/src/cfc/types.ts`) already tags *update discipline*. This is
  orthogonal to the *consumption* axis this epic adds.
- **Reads already distinguish shape.** `IReadActivity.nonRecursive`
  (`storage/interface.ts`) marks shape-only observations (key-add, length);
  `linkResolutionProbe` (`storage/reactivity-log.ts`) marks "is there a link
  here?" probes — currently *excluded* from flow taint (this exclusion **is**
  the SC-8 residual).
- **Read-side resolution already threads `nonRecursive`.**
  `effectiveReadLabel(metadata, logicalPath, nonRecursive, { excludeLinkOrigin
  })` inside `deriveFlowJoin` (`prepare.ts`) already selects labels by a
  boolean shape flag and by origin.
- **The `structure` origin already labels container shape** at exact paths
  (`prepare.ts` persist region), applying only to reads *at* the container path,
  not strictly below it.

So C is a *refinement* of existing axes, not new machinery.

## 3. Design decision: an additive `observes?` axis

Add an optional consumption axis to the persisted entry, orthogonal to `origin`:

```ts
// Shown for illustration only.
type LabelObservationClass = "value" | "shape" | "enumerate" | "followRef";

type LabelMapEntry = {
  path: readonly string[];
  label: IFCLabel;
  origin?: LabelEntryOrigin; // update discipline (unchanged)
  observes?: LabelObservationClass; // consumption class (NEW; absent = covering)
};
```

- **`origin` stays the update-discipline axis; `observes` is the consumption
  axis.** They are independent: a `derived` entry can be `observes:"value"`, a
  `structure` entry `observes:"shape"`, etc.
- **Absent `observes` = a covering entry** consumed by *every* read class. Every
  legacy (pre-C) entry is therefore covering, so a class-unaware reader
  over-taints (fail-safe) and old persisted data needs no migration. This is the
  same wire-compat move as the clause `anyOf` wrapper in Epic A.

**Alternative considered and rejected:** a single `PathLabelTemplate`-shaped
entry carrying per-class label fields (`{ value?, shape?, enumerate? }`). It
loses on two counts: (a) wire-compat — a template entry is not a covering
entry for old readers, so it needs migration; (b) it duplicates the existing
longest-prefix resolution machinery, whereas additive per-class entries reuse
it unchanged. Additive entries win.

## 4. Read-classification table (the SC-8 normative mapping)

Which observation class(es) each concrete runtime read consumes at its path.
A read consumes the join of every entry whose class is in its consumed set:

| Runtime read | Consumes classes | Notes |
|---|---|---|
| recursive value read | `value` + `shape` + `enumerate` | reading content also reveals presence/type and, for containers, membership |
| `nonRecursive` read (key-add, length) | `shape` + `enumerate` | observes presence/cardinality, not element content |
| `linkResolutionProbe` / slot-pointer read (no deref) | `followRef` | which reference sits here — **stops being excluded**; consumes the link-origin entry's `followRef` class |
| dereference (follow a ref to its target) | the dereference trace pair it already is | unchanged; target read classified at the target path |

The load-bearing change is the third row: the `followRef` observation, today
dropped from the flow join, becomes a consumed class carrying the link entry's
label — closing SC-8.

## 5. SC-4: existence grows, value replaces

On a value overwrite:

- **`observes:"value"` derived entries are REPLACED** by the committing
  attempt's derivation — the §8.12.8 replace-on-overwrite rule, unchanged. A
  less-tainted recomputation legitimately lowers the *value* label.
- **The `observes:"shape"` (existence) entry GROWS** — the join of the old and
  new derivation's flow labels. Existence reveals *every* writer across the
  path's history, so it must never shrink on overwrite. Stated explicitly
  against §8.12.8: replace-on-overwrite is a `value`-class rule; the `shape`
  class is monotone-growing like `declared`.

This is the crux of SC-4: separating the two classes lets `value` replace (the
precision win) while `shape` grows (the soundness fix), where today one label
does both and the existence bit leaks.

## 6. What `deriveFlowJoin` consumes per read shape

`forEachFlowObservation` (`prepare.ts`) already visits each read with its
`nonRecursive` flag. C1 extends it to classify each observation (value / shape
via `nonRecursive` / followRef via `linkResolutionProbe`) and select entries by
class-compatibility rather than the boolean. `excludeLinkOrigin` becomes class
selection: link-origin entries are consumed by `followRef` reads.

Parity contract for C1 — **scoped, because SC-8 is an intentional behavioral
change, not a refactor.** Today `forEachFlowObservation` *skips*
`linkResolutionProbe` reads and `deriveFlowJoin` *drops* `origin==="link"`
entries via `excludeLinkOrigin: true` (`prepare.ts`). Two distinct effects:

- **value / shape / enumerate reads** must stay **byte-identical** on legacy
  covering entries — every such read consumes every covering entry, the current
  behavior. This is the real parity test.
- **the `followRef` path** deliberately **changes**: making a slot-pointer read
  consume the link-origin entry is exactly the SC-8 fix, so the derived join for
  that path is *wider* than today by design. The parity test must exempt this
  path (or assert the new, wider result) — it is not, and must not be, claimed
  byte-identical.

## 7. Observation ceiling (LLM path) and render

The LLM observation ceiling (`llm.ts`) and render label views consume per-class
in C4: a public `value` read of a child under a secret container `shape` no
longer inherits the container's shape label (today the flat model takes the
max). That precision win is what pays for the epic on the LLM/agent surface.

## 8. Staging (C1–C5)

1. **C1 — read-shape plumbing.** Classify flow observations; `effectiveReadLabel`
   selects by class; `followRef` stops being excluded. Parity test: legacy
   covering entries → byte-identical derived join.
2. **C2 — persist split.** Write `observes:"value"` derived entries + a `shape`
   entry per written path; `structure` stamps become
   `origin:"structure", observes:"shape"`. Per-class idempotence (SC-11).
3. **C3 — the two channel fixes (red-first).** SC-4: overwrite keeps the grown
   existence/shape label. SC-8: reading which link sits at a slot now taints.
4. **C4 — consumer precision.** Observation ceiling + render views consume
   per-class; public child reads under a secret container shed the shape label.
5. **C5 — sqlite precision.** `deriveNullOriginIfc` narrows to the classes
   actually consumed.

## 9. Rollout

Two rollout regimes, because the mixed-version fail-safe holds for the additive
classes but **not** for the SC-8 change:

- **`value` / `shape` / `enumerate` — additively safe, no dial.** These are new
  covering-compatible entries; a class-unaware (old) reader consumes them as
  covering entries and **over-taints** (fail-safe). Persist-before-read is fine.
- **`followRef` (SC-8) — needs a reader-first (or dialed) rollout.** The
  fail-safe-by-construction claim does **not** hold here: a class-unaware reader
  does not treat a `origin:"link"` entry as covering — `deriveFlowJoin` **drops**
  it via `excludeLinkOrigin`. So if a new writer persists
  `origin:"link", observes:"followRef"` entries while old readers are live,
  those readers keep *dropping* the slot-pointer label — an **under-taint**, not
  a conservative over-taint. C2 must therefore either deploy the class-aware
  reader before the writer, or gate followRef persistence behind a dial flipped
  only after readers understand it. State this as a hard prerequisite for the
  SC-8 slice.

Perf: the labelMap grows ~2× entries per written path; bench
`cfc-label-sync-strategy` and `cfc-canonicalize` before/after. A spec PR to
`commontoolsinc/specs` records the §4.6.3 read-classification table and the SC-4
grow-vs-replace split when this doc settles (tracked in `cfc-spec-changes.md`).

## Provenance

Grounded in the C0 outline of `cfc-future-work-implementation.md` plus the
seam map over `cfc/types.ts` (`LabelMapEntry`/`LabelEntryOrigin`),
`storage/interface.ts` (`IReadActivity.nonRecursive`),
`storage/reactivity-log.ts` (`linkResolutionProbe`), and `prepare.ts`
(`forEachFlowObservation`, `effectiveReadLabel`, `deriveFlowJoin`, the persist
region). Residuals SC-4 / SC-8 are from `cfc-spec-changes.md`.
