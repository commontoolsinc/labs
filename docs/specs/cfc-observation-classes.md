# CFC observation classes (`PathLabelTemplate`) — design

_Epic C, stage C0, of
[`docs/history/plans/cfc-future-work-implementation.md`](../history/plans/cfc-future-work-implementation.md).
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
  (`prepare.ts` persist region), applying to reads *at* the container path and
  to recursive ancestor reads, never to reads strictly below it (per the
  `types.ts` component contract and the SC-7 note in `cfc-spec-changes.md`).

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
- An entry without `observes` covers the content observation classes.
- A legacy `origin:"link"` entry without `observes` has the `followRef`
  consumption class. Materializing a subtree exposes its contained references
  and consumes this class too. Precise reference acquisition requires the
  provenance and compatibility rules in [CFC references](cfc-references.md).

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
| recursive value read | `value` + `shape` + `enumerate` + `followRef` | materializing a subtree exposes contained values and reference identities |
| `nonRecursive` read (key-add, length) | `shape` + `enumerate` | observes presence/cardinality, not element content |
| `linkResolutionProbe` / slot-pointer read (no deref) | `followRef` | which reference sits here — **stops being excluded**; consumes the link-origin entry's `followRef` class |
| dereference (follow a ref to its target) | reference restrictions at every hop, then the target observation classes | traces record topology; actual reads and held-reference observations determine consumption |

The load-bearing change is the third row: the `followRef` observation, today
dropped from the flow join, becomes a consumed class carrying the link entry's
label — closing SC-8.

**Where `count` went.** The spec's fifth class (§4.6.3) deliberately does not
get its own axis value: a count observation (cardinality without membership)
is strictly weaker than `enumerate`, so count-shaped reads (length, `COUNT`)
consume the `enumerate` class — a sound over-approximation. A distinct
`count` value is additive later if a consumer ever needs the precision (e.g.
releasing a count more widely than membership); nothing in C1–C5 depends on
the distinction.

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

**C2 note (2026-07-03): existence entries carry confidentiality only.** "The
join of the old and new derivation's flow labels" above is a
confidentiality-channel rule. The persisted `observes:"shape"` entry does not
carry J's integrity: integrity composes by meet, never join, so growing an
existence entry's integrity across writers would *union* certification claims
— an over-claim. The `value` entry keeps the full J (confidentiality +
integrity, replace-on-overwrite); this matches the existing `structure`
stamps, which have always been confidentiality-only. Consequence: a
`nonRecursive` (shape) read of a split-labeled path taints with the existence
confidentiality but no longer inherits content certification into the
hereditary meet — an intended under-claim (SC-9's fail-safe direction).

**C3 note (2026-07-03, superseded 2026-07-06): grow shipped, then the
discipline was settled with the spec as freeze-at-creation.** C3's interim
fix grew the existence entry on every overwrite; running the open questions
against the spec (§8.12.8 as amended on specs branch
`cfc/existence-freeze-at-creation`) settled the final disciplines:

- **`observes:"shape"` (existence) entries FREEZE at creation**: minted
  once with the creating attempt's join (legacy pre-class entries are
  absorbed at the one-time migration, conservatively over-attributed to
  the first labeled stamping), never cleared and never grown by overwrites
  of a still-existing path. Soundness: a writer conditional on existence
  journals that observation itself (§8.10.1/§8.9.2). **Delete +
  re-create re-mints (resolved 2026-07-10)**: §8.12.8 makes re-creation a
  fresh creation event — the frozen entry is REPLACED at the re-creating
  attempt's join (`recreate_remints` in the spec's
  `formal/Cfc/StoreExistence.lean`), since carrying the stale join would
  UNDERSTATE the re-created path's existence channel, the direction the
  spec forbids. The carry in `prepare.ts` refuses a frozen entry whose
  path shows the per-path transition absent-before → present-after against
  the recorded writes' pre-transaction snapshots (`previousValue`, probed
  relative to each write's materialization point; the probes walk own-key
  PRESENCE — a slot holding `undefined` is present, per the storage patch
  layer — and at the recorded path itself the detail's `previousPresent`
  flag decides, with value-definedness as the fallback for transactions
  that do not provide it), and a
  replacement mints at the entry's own path with the current join — empty join mints nothing
  (a cleanly re-created path's existence is public; pre-deletion
  observations stay protected by their journaled reads). Remaining
  residual: deletion alone leaves the frozen entry in place until a
  re-creation (over-taint, the fail-safe direction — documentable).
- **`origin:"structure"` membership stamps are `observes:"enumerate"`**,
  replace-from-criteria per §8.12.8 (normative — its rationale names and
  rejects accumulate-forever). Axis-mapping note: the labs `observes` axis
  is read-op shaped, so labs `enumerate` at a container approximates the
  spec's container-level `iterate.{order,count}` label classes; the
  spec's per-child `shape` encoding of membership is a recorded residual
  (see SC note in `cfc-spec-changes.md`: a static per-child existence
  probe does not consume the container-anchored stamp).
- Cleared `link` entries never fold (pointer labels; folding them into
  content shape would re-smear the pointer/content split). Legacy
  migration conf not covered by any stamp path lands as a frozen shape
  entry at the shallowest covering written path, or the entry's own path.

## 6. What `deriveFlowJoin` consumes per read shape

`forEachFlowObservation` (`prepare.ts`) classifies application reads as value,
shape, enumeration, or reference observations and selects compatible entries.
Reference probes consume the slot's reference confidentiality. Materializing a
value through a reference consumes both that restriction and the current target
content labels. Explicit identity observations and held-reference history also
contribute to the join; a later dereference trace does not erase them.

Trusted coordinator machinery may exclude its own bookkeeping reads. This
exemption follows the runtime-owned marker, not the shape of the resulting write.
A generic pass-through or container rewrite therefore retains semantic selection
observations even when all of its written leaves are references.

### 6.1 C1 code-validation refinements (2026-07-03)

Landing C1 (`cfc/observation-classes.ts`, `forEachFlowObservation` /
`effectiveReadLabel` in `prepare.ts`) validated the §4 mapping in code and
forced three refinements the text above leaves ambiguous. Each was measured
against the phase-B pointwise suite (`cfc-flow-pointwise.test.ts`), whose
reader-visible guarantees break under the naive readings; all three are
normative from C1 on:

- **followRef reads consume only followRef-class entries — covering entries
  are content.** §3's "absent `observes` = consumed by every read class"
  holds for the content classes (`value`/`shape`/`enumerate`) only. A
  followRef observation reads a pointer, not content: letting it consume
  covering entries would taint the terminal resolution probe of every blind
  pass-through with the target doc's content label, re-smearing the §2
  pointer/content distinction.
- **A dereference trace does not erase a semantic observation.** A pointer
  comparison remains a dependency when a later read follows the same reference.
  Application traversal consumes each hop's reference restrictions. Trusted
  wiring can mark its own bookkeeping reads as machinery; application code
  does not execute in that scope.
- **Reference evidence does not endorse content.** Reference probes contribute
  confidentiality without crediting their relationship integrity as content
  evidence. A confidential held-reference observation contributes a dependency
  with no content endorsement to the hereditary integrity meet. Relationship
  evidence remains on the reference component.

## 7. Observation ceiling (LLM path) and render

C4 makes the two big consumers class-aware, both via the §4 table — same
classification, same longest-prefix resolution, applied to the ceiling fit
instead of the flow join:

- **LLM observation ceiling (`llm.ts` / llm-dialog).** Serializing a value
  into a prompt or tool context is a **recursive value read**: the ceiling
  fit consumes `value + shape + enumerate + followRef` entries at each serialized
  path, including held-reference restrictions.
  The genuinely new case is **opaque link handles**
  (`cfcOpaqueLinkForPath`): rendering WHICH reference sits at a slot without
  dereferencing it is a `followRef` observation, so an opaque handle
  consumes the link entry's `followRef` label only — not the target's
  `value` label. An opaque handle to a secret document taints the prompt
  with the pointer's label, not the secret's. Mechanically, the ceiling-fit
  path applies the same read-classification helper C1 adds for
  `forEachFlowObservation`; C4 settles which call site carries it.
- **Render label views** consume per-class the same way: a public `value`
  read of a child under a secret container `shape` no longer inherits the
  container's shape label (today the flat model takes the max).

That precision win is what pays for the epic on the LLM/agent surface.

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
