# TS Transformers Design Deltas

**Status:** Proposed (not yet implemented)  
**Date:** February 24, 2026  
**Companion:** `docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md`

## Purpose

Track intentional behavior deltas we want relative to current implementation,
and the principles that should constrain future transformer changes.

This document is a proposal backlog, not a statement of current behavior.

## Delta Backlog

## D-001 Rename Context Terms (`safe` -> `compute` / `pattern`)

**Current term:** `safe context` / `safe wrapper`  
**Proposed terms:**

- `compute context` for callbacks where values are being computed in a wrapped
  compute form (`computed`, `derive`, `action`, `lift`, `handler`, etc.)
- `pattern context` for top-level pattern/render-style author code where
  parameters are opaque by default and direct computation should trigger
  guidance/rewrite

**Rationale:**

- `safe` is misleading; all code is sandboxed and untrusted.
- The distinction is semantic (opaque authoring context vs compute callback
  context), not security/trust.

**Acceptance criteria:**

1. User-facing docs and diagnostics stop using “safe context” terminology.
2. Internal naming may migrate incrementally, but external language should be
   context-accurate immediately.
3. Terminology clearly communicates *why* computation rules differ by context.

## D-002 Context-Driven `&&` / `||` Lowering Policy In JSX

**Policy target:**

- In **compute context inside JSX**: do **not** lower `&&`/`||` to
  `when`/`unless`.
- In **pattern context inside JSX**: **always** lower
  - `a && b` -> `when(a, b)`
  - `a || b` -> `unless(a, b)`

**Rationale:**

- `&&`, `||`, and `?:` are all conditional/control-flow operators.
- Context should drive lowering policy, not heuristics like “right side is
  expensive.”
- Pattern context benefits from explicit runtime control-flow helpers.
- Compute context should preserve direct compute-expression author intent.

**Acceptance criteria:**

1. No heuristic gating for `&&`/`||` in pattern context JSX (always lower).
2. No `&&`/`||` lowering in compute context JSX.
3. Behavior is test-covered for nested/mixed logical expressions and ternary
   adjacency.

## D-003 Context-Driven Collection Operator Policy (`.map` first, then analogs)

**Policy target:**

- In **pattern context**: rewrite reactive collection operators to explicit
  reactive forms.
- In **compute context**: rewrite only when receiver type is in the
  non-auto-unwrapped cell-like set (`Cell`, `Writable`, `Stream`, etc.).
- Never rewrite plain JS array operators.

**Initial operator in scope:** `.map`  
**Future analogous operators:** `.filter`, `.find`, `.some`, `.every` (subject
to runtime contract support).

**Rationale:**

- `.map` is the hardest nested case and currently mixes context and type
  heuristics.
- We want one matrix-driven rule for all collection operators, starting with
  `.map`.

**Acceptance criteria:**

1. `.map` rewrite decisions are fully explained by `{context, receiverKind}`.
2. Pattern-context `.map` on reactive receivers is always rewritten.
3. Compute-context `.map` rewrites only for non-auto-unwrapped cell-like
   receivers.
4. Context evaluation uses the **active context at the operator site after
   prior rewrites**, including synthetic compute wrappers introduced by JSX
   rewriting.
5. Test matrix exists and is extensible to future operators.

## Principles

## P-001 Terminology Must Describe Semantics, Not Trust

Names should reflect execution model and data semantics. Avoid terms implying
security guarantees (`safe`) when all authored code is sandboxed and untrusted.

## P-002 Context Is A First-Class Semantic Axis

Transformer policy should branch first on context category:

- pattern context: opaque-facing author code
- compute context: callback-local computed code

This should be explicit and centralized, not scattered via ad-hoc checks.

## P-003 Conditional Operator Family Should Be Handled Coherently

`&&`, `||`, and `?:` belong to one control-flow family. Rewriting policy should
be consistent and context-defined for all three, rather than using independent
heuristics per operator.

## P-004 Preserve JavaScript Semantics Exactly

Rewrites must preserve short-circuit and value-return semantics:

- `&&`: returns left if falsy, else right
- `||`: returns left if truthy, else right
- `?:`: returns selected branch

Lowering is acceptable only when semantic equivalence is exact.

## P-005 Make Reactive Boundaries Explicit Where Opaque Values Dominate

In pattern context, emitted forms should make reactive/opaque boundaries
explicit (`when`, `unless`, `ifElse`, `derive`, schema boundaries), to reduce
implicit behavior and runtime ambiguity.

## P-006 Minimize Rewrite Surface In Compute Context

Compute contexts already encode computation intent. Prefer preserving authored
expression structure there unless a rewrite is strictly required for correctness.

## P-007 Deterministic, Explainable Rules Over Heuristics

Choose small deterministic policies tied to context/operator class. Avoid
“expensive RHS” style heuristics where possible because they are harder to
predict and explain.

## P-008 Diagnostics Should Teach The Model

When disallowing expressions in pattern context, diagnostics should explain:

1. what context the user is in,
2. why direct computation is constrained there,
3. which compute-context wrapper to use.

## Candidate Implementation Touchpoints

- `packages/ts-transformers/src/ast/reactive-context.ts`
- `packages/ts-transformers/src/ast/type-inference.ts` (`isReactiveArrayMapCall`)
- `packages/ts-transformers/src/transformers/opaque-ref-jsx.ts`
- `packages/ts-transformers/src/transformers/opaque-ref/emitters/binary-expression.ts`
- `packages/ts-transformers/src/transformers/opaque-ref/emitters/conditional-expression.ts`
- `packages/ts-transformers/src/closures/strategies/map-strategy.ts`
- `packages/ts-transformers/src/ast/call-kind.ts`
- validation messaging in
  `packages/ts-transformers/src/transformers/pattern-context-validation.ts`
- docs currently describing “safe context,” including
  `packages/ts-transformers/docs/SAFE_CONTEXT_TRANSFORMS_DESIGN.md`

## Simplification Recommendations

## S-001 Replace Overlapping Context Predicates With One Classifier

**Current complexity:** multiple partially-overlapping helpers:

- `isInsideSafeCallbackWrapper`
- `isInsideSafeWrapper`
- `isInsideRestrictedContext`
- `isInRestrictedReactiveContext`

**Recommendation:** introduce one context API:

```ts
type ReactiveContextKind = "pattern" | "compute" | "neutral";
interface ReactiveContextInfo {
  kind: ReactiveContextKind;
  inJsxExpression: boolean;
  owner: "pattern" | "render" | "array-map" | "computed" | "derive" | "action" | "lift" | "handler" | "standalone" | "unknown";
}
```

Consumers should read `kind` rather than composing multiple booleans.

The classifier must treat synthetic callback boundaries created by earlier
passes as authoritative context boundaries. Example target behavior:

```tsx
<div>{[0, 1].forEach(() => list.map(...))}</div>
```

If JSX rewriting first introduces a compute wrapper (`computed`/`derive`) around
this expression, the nested `list.map(...)` is in compute context for subsequent
collection rewrite policy.

## S-002 Centralize Rewrite Decisions In A Policy Module

**Current complexity:** rewrite rules are spread across emitters/strategies and
partly heuristic.

**Recommendation:** add a policy module (for example
`src/policy/rewrite-policy.ts`) with pure functions:

1. `shouldLowerLogicalInJsx(context, operator)`
2. `shouldRewriteCollectionMethod(context, method, receiverKind)`
3. `classifyReceiverKind(type) -> "plain" | "opaque_autounwrapped" | "celllike_requires_rewrite"`

Emitters/strategies call policy functions instead of embedding local logic.

## S-003 Split Binary Rewriting Into Two Independent Steps

**Current complexity:** `emitBinaryExpression` mixes:

1. logical lowering (`&&`/`||`)
2. derive/computed wrapping fallback
3. expensive-RHS heuristics

**Recommendation:** structure as:

1. operator-class handling (`&&`/`||`) via policy matrix
2. generic expression wrapping path for remaining cases

This makes conditional-operator behavior auditable and removes heuristic-driven
branching.

## S-004 Generalize Map Strategy Into Collection Method Strategy

**Current complexity:** map-specific logic is split across:

- call-kind detection
- type-inference helpers
- closure map strategy
- context checks in multiple files

**Recommendation:** introduce a method-agnostic strategy base with per-method
adapters. Phase 1 uses only `map`, but architecture supports future methods.

This keeps `map` semantics intact while reducing future copy/paste complexity
for `.filter`-class operators.

## S-005 Make Diagnostics Context-Literate

**Current complexity:** messages refer to “safe context,” which conflates trust
with semantics.

**Recommendation:** diagnostics should explicitly mention “pattern context” vs
“compute context” and explain why behavior differs there.

## S-006 Add A First-Class Context Policy Test Matrix

**Current complexity:** coverage is broad but not organized as a policy matrix.

**Recommendation:** add table-driven tests for:

1. context kind (`pattern`, `compute`)
2. operator (`&&`, `||`, ternary)
3. method (`map`, future analog)
4. receiver kind (`plain`, `opaque_autounwrapped`, `celllike_requires_rewrite`)

This turns policy regressions into obvious test failures.

## Proposed Implementation Path

## Phase 0: Lock Baseline And Prepare Rollout

1. Add explicit characterization tests for current `.map` nested behavior and
   logical lowering behavior.
2. Add a transformer option gate for new policy path (for example
   `contextPolicyV2`) so rollout can be incremental.

**Exit criteria:** baseline green; feature gate available.

## Phase 1: Terminology Migration (Low-Risk)

1. Update docs and diagnostics from “safe” to “compute/pattern” terms.
2. Keep existing function names internally if needed, but update user-facing
   text immediately.

**Exit criteria:** no user-facing “safe context” wording in transformer docs and
diagnostics.

## Phase 2: Context Classifier Introduction

1. Implement `getReactiveContextInfo(node, checker)`.
2. Re-implement old helpers as wrappers over the new classifier to preserve
   compatibility.
3. Migrate a first consumer (`pattern-context-validation`) to classifier-first
   flow.

**Exit criteria:** one canonical context implementation; old helpers become thin
compatibility shims.

## Phase 3: Logical Operator Policy Rewrite

1. Implement `shouldLowerLogicalInJsx`.
2. Refactor `emitBinaryExpression` to use policy matrix (remove expensive-RHS
   gating for policy-controlled paths).
3. Keep semantic equivalence checks via snapshots/fixtures.

**Exit criteria:** `&&`/`||` behavior determined by context matrix, not local
heuristics.

## Phase 4: `.map` Policy Simplification

1. Implement `classifyReceiverKind`.
2. Refactor `shouldTransformMap` in `map-strategy.ts` to policy-driven form:
   `{contextKind, receiverKind}`.
3. Add nested context fixtures that assert:
   - pattern-context reactive map rewrites
   - compute-context rewrite only for cell-like set
   - synthetic compute-context boundaries introduced by earlier JSX rewrite
     passes (for example `forEach(() => list.map(...))` inside JSX) are honored

**Exit criteria:** `.map` rewrite decisions are matrix-driven and test-backed.

## Phase 5: Collection Method Generalization Scaffold

1. Introduce collection-method strategy abstraction with `map` as first method.
2. Define placeholder policy entries for future operators without enabling
   runtime behavior yet.

**Exit criteria:** architecture ready for `.filter` analog without repeating map
logic.

## Phase 6: Cleanup

1. Remove superseded heuristic branches.
2. Delete or deprecate old context helper names once all consumers migrate.
3. Update behavior and goals specs to final terminology/policy.

**Exit criteria:** no dead-path fallback logic for replaced policies.

## Open Questions

1. Should ternary in compute context JSX also be preserved (no `ifElse`
   lowering), mirroring the proposed `&&`/`||` rule?
2. Do we want a strict “context policy matrix” test suite that all operator
   rewrites must satisfy before merge?
3. Should naming migration happen in one pass or with temporary aliases to avoid
   destabilizing in-flight work?
4. Should `contextPolicyV2` be short-lived (one release) or support a longer
   dual-path migration window?
