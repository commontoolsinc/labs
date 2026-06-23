# CFC trust model and label propagation

The interpreter replaces a *structural* CFC guarantee with a *trusted* one, so
this is the part that must be exactly right. This document specifies how the
interpreter propagates labels soundly, what new trusted machinery it depends on
(some of which does not exist yet), the soundness obligations it must discharge,
and how it corresponds to the CFC formal spec.

References are to the CFC spec at `~/src/specs/cfc` (chapter numbers) and to the
runner CFC code (`packages/runner/src/cfc/`). **Where a mechanism is named as a
prerequisite, it is not yet implemented in the runner** — see §3 and
[04](./04-scheduler-and-transformer-deltas.md) §0.

---

## 1. The single fact that drives everything (and the honest tradeoff)

Today's CFC flow propagation collapses to **one** `{confidentiality, integrity}`
pair per transaction, derived by `deriveFlowJoin` (`prepare.ts:1319-1361`):
confidentiality is the **union** of all observed inputs' confidentiality;
integrity is a **class-aware meet** (`hereditaryMeet`, `prepare.ts:1349-1361`) —
only hereditary atoms present on *every* observation survive. The result is
stamped on the transaction's value-write targets (as a `derived` metadata
component in persist mode, `prepare.ts:3119-3127`). For a single sandboxed
function that is the only sound choice: all reads taint all writes (with
integrity *narrowing*, not widening).

The *only* way the system gets finer (pointwise) labels today is **structural
decomposition**: `map`/`filter`/`flatMap` run each element op in its **own
transaction** that reads only that element, so the per-element journal does not
contain the other elements and the conservative join is *already* pointwise.
CFC §8.5.4.3 designates this decomposition the **preferred** mechanism, and
§8.9.1 designates trusted flow-precision claims the **fallback for
non-decomposable** ops. The runner now relies on exactly this: the previous
untrusted precision shortcut (`flowPrecisionSchemaForBuiltin`) was **removed**,
and `list-result-schema.ts:9-15` records that pointwise precision "is a
structural fact of the transaction decomposition rather than a trusted claim."

**That structural decomposition is precisely the `~3 documents + ~4 nodes per
element` cost.** The interpreter's whole purpose is to stop paying it. So the
interpreter **stops decomposing** — and therefore can no longer get pointwise
labels for free. It must instead **assert** them, as a trusted claim.

This is the honest framing, and it is the opposite of a security improvement:

> The interpreter deliberately abandons the *preferred* (structural) mechanism
> for pointwise precision and **re-incurs** the §8.9.1 trusted-claim obligation
> that decomposition currently discharges for free. This is a **net increase in
> trusted-claim surface**, justified solely by the measured footprint win
> ([05](./05-baselines.md)), not by CFC. The burden of this document is to show
> the re-incurred claim can be made sound, gated, and fail-closed.

## 2. What the interpreter is, in CFC terms

- It is **trusted runtime code in the TCB**, with verified implementation
  identity (`kind: "builtin"`), like `map.ts` today. Its
  `implementationIdentityAtom` is a `Builtin` atom (§8.9.1 pseudocode). The
  decision: **the interpreter is in the trusted computing base**; per-interpreter
  trust suffices for the §8.9.1 gate. There is **no** per-ROG-content-hash trust
  granularity ([01](./01-requirements.md) §9 R-6).
- This is sound because **trusting the interpreter does not require trusting the
  ROG.** The interpreter computes label *values* from the data it actually reads,
  under structurally-enforced read isolation (§5.2), *regardless of what the ROG
  claims* — so a malformed or adversarial ROG cannot induce an unsound label; at
  worst it produces a wrong *value* (which is the ROG author's own data) within
  correct labels. Hence trusting the interpreter for `flow-taint-precision`
  wholesale is the right model: soundness rests on the interpreter's correctness
  (the formal obligations, §8), not on per-program trust.
- It is **not** the transformer. Nothing the transformer emits is a trusted
  claim. The interpreter computes label *values* from the data it actually reads
  (§4), and only the interpreter's own assertions — attributed to its TCB identity
  — are relied upon.

## 3. The trust boundary (NG-001 honored) — and what must be built first

The transformer is not a trust boundary. The interpreter is. Concretely:

- **R-CFC-1 — values from runtime data.** For every op, the interpreter computes
  the output label from the labels of the inputs it *actually read* at runtime.
  It never reads a label value out of the ROG.
- **R-CFC-2 — structure is an untrusted hint.** The transformer may emit the
  *structure* of propagation (which input flows to which output) and the inner
  order. The interpreter MUST re-derive structure from the ROG it is already
  walking, or verify a hint is a sound over-approximation before relying on it,
  and MUST **fail closed** to the conservative join if a hint is missing,
  malformed, or fails verification. (The inner *order* is soundness-inert — a
  wrong order at worst costs an extra interior iteration, R-EXEC-5 — so it may be
  trusted for scheduling but not for labels.)

**Prerequisite machinery that does not exist yet.** The §8.9.1 trust gate is
**unimplemented in the runner**: there are zero occurrences of
`isTrustedForConcept`, `FLOW_TAINT_PRECISION`, `deriveLabelWithTrustGate`, or a
`flow-taint-precision` concept under `packages/runner/src/`. Today it is CFC-spec
pseudocode plus a single-`Label` Lean definition (`Cfc/LabelTransitions.lean`).
This design therefore **requires building**, as a prerequisite
([04](./04-scheduler-and-transformer-deltas.md) §0):

1. concept-trust delegation (CFC §4.8) and the acting-user trust closure;
2. implementation-identity → concept resolution;
3. the gate itself (`deriveLabelWithTrustGate`), generalized from a single
   `Label` to a path-granular `LabelView` (a new obligation, §8);
4. the path-granular flow-precision claim atoms
   (`PointwisePresencePreserved`, `PointwiseWriteDependency`, and for
   filter/flatMap `ElementLocalExpansion` / `StableRelativeOrder`, §5.3).

None of this is a hook into existing code. The design's CFC soundness is
*conditional on building it*.

## 4. Per-op label computation

The interpreter computes a path-granular label per op as it evaluates it. **Two
distinct operations must not be confused:**

- **View accumulation** — assembling a path-addressed `CfcLabelView`
  (`mergeCfcLabelViews` / `rebaseCfcLabelView`, `label-view-core.ts`) is a
  *union over both label axes*. It is correct for *carrying* labels at different
  paths, but it is **not** a flow join: using it to *derive* an output label
  would union integrity, i.e. **raise** integrity — the unsound dual direction.
- **Flow join (`⊔`)** — deriving an output label from input labels is
  confidentiality **union** plus the class-aware integrity **meet** of
  `deriveFlowJoin` (`hereditaryMeet`). The interpreter MUST use this for every
  output it derives, and MUST NOT use `mergeCfcLabelViews` as `⊔`.

```text
labelOf(op, ins, pc):
  case op.kind of
    leaf:        flowJoin(ins) ⊔ pc              # NG1: all leaf inputs taint all leaf outputs (coarse)
    access:      rebase(ins[0].label, op.path)   # navigate the input's label view to the sub-path
    construct:   per field f: flowJoin(inputs bound to f) ⊔ pc
    control:     flowJoin(label(selected branch), label(predicate)) ⊔ pc   # predicate is PC
    collection:  pointwise / element-local (see §5)
    pattern:     flowJoin(nested result label) ⊔ pc
    effect:      no output label; gate egress at the sink ceiling (§6)
```

where `flowJoin` is confidentiality-union + integrity-meet, and `⊔` likewise.

**Invariant (BL-3 / I5).** For every derived output, output **integrity ⊆ each
contributing input's integrity** (the meet never adds an integrity atom), and
output **confidentiality ⊇ each contributing input's confidentiality** (the
union never drops one), except where a *passing* §8.9.1 trust gate authorizes a
relaxation. No path may raise integrity or lower confidentiality without that
gate.

**Precision is bounded by leaf coarseness (MN-1).** A `leaf` emits one coarse
label over its whole output (NG1). So `access` / `construct` buy precision only
when the navigated subtree was *interpreter-produced* (a `construct`, a
`collection`, or a navigated `access`), not when it is interior to a leaf's
opaque output. The realizable label-precision win is at the reactive skeleton,
not inside leaves.

`pc` (flow-path confidentiality) is the join of the confidentiality of every
observation that determined whether/how this op ran, including **trigger reads**
(§5.4). It is conservative by default; narrowing it is a gated claim (§5.4).

## 5. Collections — the trusted claim, and what makes it sound

### 5.1 The pointwise rule (map)

For a `map`, the interpreter produces a container whose label *metadata* carries
a **per-index** entry: index `i` carries the label of element `i`'s computation
only, plus the list's structural label at the root.

Crucially, per-index labels must be written **with origin** into the stored CFC
metadata, not merely assembled into a component-blind `CfcLabelView`. The
`declared` / `link` / `derived` / `structure` component discipline
(`cfc/types.ts:145-165`) — in particular the `structure` component that "exists
to preserve the pointwise per-element split" — lives on stored metadata entries
(`LabelEntryOrigin`), which `CfcLabelView` does not carry (MA-10). The
interpreter therefore writes per-index labels as `derived`/`structure`
components on the container document's metadata at path `[i]`, the same
representation a per-element transaction would produce.

```text
collectionLabel_map(op, elements):
  for (es, i) in elements:
    writeMetadataComponent(container, path=[i],
                           label = es.label,        # element i's isolated-read flow join (§5.2)
                           origin = derived/structure)
  writeMetadataComponent(container, path=[],
                         label = structuralLabelOfList(op.listInput),  # membership/order, §8.5.6
                         origin = structure)
```

**The §8.9.1 gate, with the interpreter in the TCB (§2).** Each per-element label
is a flow-precision claim that must pass the §8.9.1 gate (a claim less restrictive
than the conservative whole-batch join is admitted only for a trusted claimant).
Because the interpreter is in the TCB, that trust check is satisfied by the
interpreter's identity — no per-acting-user delegation and no per-ROG hash. The
gate **mechanism** still has to be built (§3 prerequisite); until it exists, and
on any gate/label-read error, the interpreter MUST **fail closed** to the
conservative join. The soundness of *admitting* the claim then rests entirely on
read isolation (§5.2) and the interpreter's correctness, not on the ROG.

### 5.2 Read isolation — the load-bearing soundness obligation

The claim being made is: *element `i`'s output label depends only on element
`i`'s inputs (plus the list structural label and PC), not on the other
elements.* In the per-element-transaction model this is a structural fact of
separate journals. In the interpreter all elements are evaluated under one
transaction sharing one `InterpreterState`, so it is an **assertion** — and the
review correctly identifies this as the weakest link: a bug where
`evalElement` reads sibling or shared interior state yields an under-tainted
label that passes the gate, the digest, and the self-recheck.

Therefore (normative, R-CFC-ISO):

- **Read isolation MUST be enforced, not asserted.** Per-element evaluation MUST
  run against a **read-scoped view** in which observing another element's data is
  *impossible*, not merely intended. Concretely: `evalElement(es, slot, i)`
  receives only element `i`'s inputs and a label-read capability scoped to
  element `i`'s reachable cells; cross-element reads are a runtime error, not a
  silent join. This factors element evaluation through `(i, xs[i])`, mirroring
  the per-element journal structurally rather than by convention.
- **The differential oracle is fail-closed on this.** O2
  ([06](./06-migration-plan.md) §4) MUST reject any element label lower than that
  element's *isolated-read* flow join (computed against element `i` alone). This
  is the empirical complement to the formal read-isolation lemma (§8 obligation
  3).

This is the proof obligation a formal reviewer will demand as a hard gate before
G3. The design's pointwise precision is sound **iff** read isolation is
structurally enforced; the spec commits to enforcement, not assertion.

### 5.3 filter and flatMap are NOT pointwise (MA-12)

`filter` and `flatMap` do not have pointwise index identity:

- A `filter` output's position depends on which earlier elements passed; the
  predicate decisions contribute membership/order/multiplicity confidentiality
  that MUST taint the **container** structural label (§8.5.6.1), and the
  per-output relation is `ElementLocalExpansion` + `StableRelativeOrder`, not
  `PointwisePresencePreserved` (§8.5.4.2).
- A `flatMap` lands element `i`'s sub-array at a **runtime-variable offset**, so
  per-index label entries shift when an upstream sub-array's length changes — the
  labels must be attached to element-local content and re-derived on length
  change, not pinned to absolute indices.

So R-CFC-3's claim set is split: `map` asserts `PointwisePresencePreserved` +
`PointwiseWriteDependency`; `filter` / `flatMap` assert `ElementLocalExpansion` +
`StableRelativeOrder` and additionally taint the container structure with the
predicate/expansion decisions. Each is gated identically (§5.1 gate), but they
are different claims and the spec must not conflate them.

### 5.4 Trigger reads (R-CFC-4)

A reactive re-run has an input its own journal does not contain: *why it was
scheduled.* §8.9.2 (Propagation Algorithm, trigger-reads block) requires the
labels of the trigger-set addresses to join the run's labels. The interpreter
receives the trigger set from the scheduler (`invalidCauses`,
`addCfcTriggerReads`, verified at `action-run.ts:329-331`) and:

- By default joins each trigger address's label into the `pc` of **every**
  recomputed op (the conservative default).
- MAY scope the trigger join to the sub-graph the trigger *influences* — but
  "influences" MUST be a sound over-approximation of the actual influence
  relation (including residual-channel branches that do not re-read the trigger,
  CFC §8.9.2), and any such narrowing is itself a flow-precision claim gated like
  §5.1. ROG-structural reachability is a valid over-approximation only if it
  dominates the influence relation.
- MUST NOT let a **self-suppressed** change (the interpreter's own committed
  writes, identified by `tx.nodeId` / `isOwnCommitSource`, `notifications.ts:133`)
  enter the trigger set — a change that did not cause scheduling must not taint
  (P5).
- MUST apply the trigger-label join **even when an op's value is unchanged**: a
  re-run can leave values identical yet still require a `pc`/label update from a
  new trigger. The `evalIncremental` value-gated early-return
  ([02](./02-design.md) §3.2) MUST NOT skip a required trigger-label join (MA-5
  n16).

## 6. Egress, fail-closed, and label persistence

- **R-CFC-5 — chokepoints unchanged.** `effect` ops that egress (render, `fetch`,
  `llm`, mail) MUST go through the existing per-sink ceiling
  (`sink-inventory.ts`, `observation.ts`) with the existing fail-closed
  discipline (`CFC_LABEL_READ_FAILED_ATOM` ungrantable). Note the existing render
  caveat (S15): render currently has author-exercisable declassification a
  deny-boundary cannot override; the interpreter inherits, not changes, that
  posture. The interpreter computes the egress value's label the same
  path-granular way and presents it to the ceiling. It MUST NOT bypass the
  `["cfc"]` / `cid:` / `source` write chokepoint.
- **Fail closed on errors.** Any label-read error, unresolved `ImplRef`, missing
  hint, or failed read-isolation MUST degrade to the conservative whole-batch
  join (or reject), per R-CFC-2 / R-CFC-ISO.
- **R-CFC-6 — label persistence and recheck (restated against what exists).**
  There is **no digest/receipt machinery in the runner** to "bind into." What
  exists: `prepareBoundaryCommit` (`prepare.ts:3087`) stamps the derived label as
  a `derived` metadata component on value-write targets
  (`prepare.ts:3119-3127`), and the idempotency recheck re-runs and compares
  *values*. So the requirement is: the interpreter's per-output labels MUST be
  persisted as the same stored metadata components a per-element transaction
  would write (§5.1), so they are covered by the existing metadata-component
  machinery and any future verifier — **not** "bound into a commit digest" that
  does not exist. The verifiable-execution receipt envelope (§3.3) is a *future*
  dependency, not a current one; §7 states the intended mapping for when it
  lands, and the present gate is the differential oracle (§5.2,
  [06](./06-migration-plan.md) §4).

## 7. One transaction, many operations — the future receipt mapping (D6)

The interpreter runs many internal operations under one transaction/commit.
**The runner has no receipt machinery today** (MN-6), so this section is the
intended mapping for *if and when* the verifiable-execution receipt envelope
(§3.3) is built, not a current claim:

- The **unit of commitment would be the interpreter run**, not each interior op:
  the receipt records the ROG's content-addressed identity (code), the external
  read-set (inputs), and the materialized outputs with their path-granular labels
  (output + CFC labels), with the flow-precision concept relied on as the
  policy/trust component.
- Interior ops are inside the committed code (the ROG + the interpreter builtin),
  as statements inside a `lift` body are inside that leaf's code today.

This avoids conflating distinct code/input/output triples, but it is a
forward-looking design note; nothing in the present design depends on a receipt
existing.

## 8. Correspondence to the formal spec — this is NEW proof work

The earlier draft claimed the interpreter "reduces through the existing
`ReactiveOperationGraph` bridge" and is "one step from proof." **That is wrong**
and is retracted:

- The Lean type named `ReactiveOperationGraph`
  (`Cfc/Proofs/OperationGraphBridge.lean:78-115`) is an **audience-delivery
  abstraction**: its node kinds are `{normalizeChapter8, authorizeAndExecute,
  deliverToAudience}`, it has four hardcoded value refs, no evaluation semantics,
  no collections, no per-element labels, and no transaction model. It imports
  neither `PointwiseFlow` nor `Collection`. It is a **namesake**, not the
  interpreter's IR.
- `Cfc/PointwiseFlow.lean` and `Cfc/Collection.lean` characterize the *decomposed*
  model over **values** (e.g. `pointwiseMap` maps dense/sparse arrays slot-by-
  slot), **label-free**. They are not a labeled batched-evaluation semantics and
  do not, on their own, give the interpreter's soundness.

So the soundness story is **new model work**. The new proof obligations
(enumerated for the CFC companion, [06](./06-migration-plan.md) §6) are:

1. **Interpreter operational model** — a total Lean semantics of
   `evalFull` / `evalIncremental` over a real ROG datatype
   (leaf/access/construct/control/collection/pattern/effect).
2. **Labeled decomposed reference semantics** for collection ops (per-element
   read-set ⇒ per-element label view) + agreement with the current runtime. This
   is the missing left-hand comparator (`PointwiseFlow`/`Collection` are
   label-free, value-only).
3. **Read-isolation lemma** — element evaluation factors through `(i, xs[i])`
   (refines the sparse-by-key model), making the pointwise claim sound *by
   construction* (§5.2). Hard gate.
4. **Refinement theorem** — interpreter label view ≥ obligation 2's decomposed
   label view, for all ROG `g` and inputs `σ`.
5. **Incremental == full** — value-gated-prune soundness + trigger-read label
   join (§5.4) + read-delta maintenance even on value coincidence.
6. **Trust-gate composition on `LabelView`** — generalize the single-`Label`
   `applyFlowPrecisionClaimGate` (`Cfc/LabelTransitions.lean`) to a path-granular
   view, preserving I5 (no narrowing without trust).
7. **Integrity-meet (not union)** lemma — output integrity ⊑ each input's
   integrity (formalizes the BL-3 direction).
8. **Materialization soundness** — the static write surface over-approximates the
   dynamic reachable set (MA-2 / P4).
9. **Trigger-read scoping soundness** — sub-graph scoping is sound vs the
   conservative join (§5.4).
10. **New §18 runtime-profile theorem connection** — the profile is
    theorem-connected (CFC Full-Proof Contract clause 4), not regression-only
    prose.

Obligations 1–4, 6, 7 are **new model surfaces**, not refinements onto existing
theorems. The companion CFC-spec change ([06](./06-migration-plan.md) §6) adds
the runtime profile, the normative pseudocode, and these obligations. "Formal one
step away" is not the claim; "formalizable, with the obligations stated" is.
