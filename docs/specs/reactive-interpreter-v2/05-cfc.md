# 05 — CFC: what carries over, what changes

v1's `03-cfc.md` (on the #4298 branch) is the best document in the v1 set and
carries over **wholesale** as the v2 trust model. This document only states
what v2 inherits by reference and where v2 differs.

## 1. Inherited verbatim

- **The honest framing**: the interpreter abandons the *structural*
  (decomposition-based) pointwise mechanism and re-incurs the §8.9.1
  trusted-flow-precision-claim obligation. This is a net increase in
  trusted-claim surface justified by the measured footprint win, not a
  security improvement.
- **The trust boundary**: the interpreter is in the TCB (per-interpreter
  trust, no per-ROG-hash granularity); the ROG is untrusted data; R-CFC-1
  (label values from runtime reads only) and R-CFC-2 (structure is an
  untrusted hint; fail closed to the conservative join).
- **Flow join vs view accumulation**: deriving output labels uses
  confidentiality-union + class-aware integrity-meet (`deriveFlowJoin`);
  `mergeCfcLabelViews` is for *carrying* path labels, never for deriving
  (the union-raises-integrity trap).
- **Read isolation is enforced, not asserted**: per-element evaluation runs
  against a scoped view where a cross-element read is an error; the
  broken-mirror oracle (a deliberately de-isolated interpreter must fail the
  pointwise oracle) stays a permanent CI gate.
- **Per-segment ≈ legacy granularity** (v1 07 F3): legacy is per-node/per-tx,
  so segments recover legacy precision while collapsing nodes — the claim is
  parity, not improvement.
- **The trigger-label caveat**: value-gated pruning must never skip a
  required trigger-read label join.

## 2. v2 deltas

### 2.1 Boundary read-through by construction

v1's F1/F3 hazard — an effect→effect hop (`generateText(fetchData(x))`)
writing a boundary input with no journaled read of the source label — was an
extraction precondition patched into extract.ts. In v2 the IR carries
`effect.inputs` and `effect.writeTargets` structurally
([02-ir.md](./02-ir.md) §2.4), so every boundary-input doc is produced by a
labeled read-through as a property of emission, and the partition's F4 cut
edges come from the same fields. There is no "remember to extend extraction"
class of CFC precondition left.

### 2.2 Function lowering does not extend the trust argument

A lowered `FnDef`/`call`/stdlib op is evaluated by the trusted interpreter
over inputs it actually read; labels derive from those reads. A wrong or
adversarial lowering yields wrong *values* (the author's own data) inside
correct labels — exactly the v1 argument for malformed ROGs. What grows is
the **fidelity surface**: every registry entry must reproduce JS semantics
exactly, or interpreted output silently diverges from the legacy-expanded
path. That is a correctness obligation (differential oracle,
[06-migration-plan.md](./06-migration-plan.md) §4), not a soundness one.

Two label rules are pinned for the lowered vocabulary:

- **Static-operand joins** (v1 E-4): control and any future short-circuiting
  evaluation compute the label join over the static operand set, even when
  value evaluation skipped an operand.
- **Stdlib ops are pure flows**: output label = flow join of the inputs
  actually resolved; no stdlib entry may consult ambient state (enforced by
  registry review — entries like `toLocaleString` are inadmissible).

### 2.3 The unbuilt machinery is scheduled, not assumed

Still true in v2, inherited from v1 03-cfc §3 and re-verified there: the
§8.9.1 gate does not exist in the runner (`isTrustedForConcept`,
`deriveLabelWithTrustGate`, the flow-precision claim atoms
`PointwisePresencePreserved` / `PointwiseWriteDependency` /
`ElementLocalExpansion` / `StableRelativeOrder`). v2-core does not need it —
Option A gets pointwise structurally, per-element-tx, exactly as legacy map
does. The gate + the per-path content-label emit (R-SEAM-3) are work order
V5b with the v1 03-cfc §8 proof obligations attached (new operational model
+ refinement theorem — new proof work, not a reduction), and only V5b's O(1)
containers depend on them.

### 2.4 OQ-4's residual: cross-element label pollution

v1's per-element effects give correct pointwise labels in isolation, but a
*segment* that feeds many elements re-reads its whole input set on any
element's change, bloating what its tx journals. v2's per-path read sets
(D-V2-READSETS) shrink this — a segment's journal is its declared paths —
but the full discharge (per-path `derived` emit on the write side) is V5b.
Until then the divergence direction stays what v1 measured: over-taint,
fail-safe, oracle-monitored.
