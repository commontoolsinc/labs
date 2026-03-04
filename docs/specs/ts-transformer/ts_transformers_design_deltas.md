# TS Transformers Design Deltas

**Status:** Partially implemented (status snapshot)\
**Date:** March 4, 2026\
**Companion:**
`docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md`

## Purpose

Track intentional behavior deltas, what has landed, and what remains relative to
the current implementation.

This document is a mixed roadmap/status artifact. It includes both landed
behavior and open follow-up work.

## Delta Backlog

## Implementation Snapshot (March 4, 2026)

- Landed:
  - `useLegacyOpaqueRefSemantics` option with capability-first default
  - unified context classifier (`pattern` / `compute` / `neutral`)
  - deterministic JSX logical lowering policy (`&&` / `||`) by context
  - `.map` rewrite matrix by `{context, receiverKind}`
  - pattern callback canonicalization and `key(...)` lowering
  - capability analysis with path/capability shrinking at schema boundaries
  - additive wrapper support for `ReadonlyCell` / `WriteonlyCell` / `OpaqueCell`
  - static destructuring default initializer lowering to schema defaults
  - array destructuring lowering in pattern/map callbacks
  - wildcard classification includes `for...of` over tracked sources
  - empty-array cell-factory validation (`cell-factory:empty-array`)
  - schema-generator synthetic union parity for `undefined` members
  - map capture classification hardened for reactive vs non-reactive captures
  - pattern-boundary schema continuity alignment (defaults-only application
    mode)
- Partially landed:
  - diagnostics migration (legacy codes preserved; some legacy validation
    remains)
  - legacy cleanup and helper deprecation
  - compute-context interprocedural capability summaries (MVP scope)
- Open:
  - standalone-function `.map` policy finalization
  - collection-method generalization beyond `.map` (`.filter`, etc.)
  - full diagnostics convergence onto lowerability-only checks

## D-001 Rename Context Terms (`safe` -> `compute` / `pattern`)

**Current term:** `safe context` / `safe wrapper`\
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
3. Terminology clearly communicates _why_ computation rules differ by context.

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
- The callback parameter of `.map` is treated as a **pattern callback
  parameter** only in cases where the call is actually rewritten to
  `mapWithPattern`. If a `.map` is not rewritten, its callback parameter keeps
  ordinary compute/plain semantics.

**Initial operator in scope:** `.map`\
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
4. Context evaluation uses the **active context at the operator site after prior
   rewrites**, including synthetic compute wrappers introduced by JSX rewriting.
5. `.map` callback parameter context is conditional on transform outcome:
   rewritten `.map` -> pattern callback semantics; non-rewritten `.map` ->
   regular callback semantics.
6. Test matrix exists and is extensible to future operators.

## D-004 Replace OpaqueRef-Heuristic Typing With Capability Dataflow + Type Shrinking

**Policy target:**

- Move away from relying on complex proxy-heavy `OpaqueRef<T>` surface types as
  the primary decision source for transform policy.
- Build a flow-aware capability model from normal parameters/locals and
  propagated origins.
- Treat pattern inputs and outputs of `lift(...)` / `pattern(...)` inside
  patterns as origin sources, then follow aliases/reassignments/destructuring.
- Apply context-specific propagation rules:
  - In pattern context, boundary signatures are intentionally based on
    directly-observed local usage for legality analysis, but emitted boundary
    schemas keep broad shape/default continuity.
  - In compute context, forwarded values should eventually use interprocedural
    summaries so helper calls contribute to required capability.
- Summarize actual usage at compute-oriented boundaries:
  - read-only -> `ReadonlyCell<T>`
  - write-only -> `WriteonlyCell<T>`
  - read+write -> `Cell<T>` / `Writable<T>`
  - pass-through only -> `OpaqueCell<T>`
- Shrink structural types in compute context to paths actually observed as
  read/written, with conservative fallback to broader shape on unknown-dynamic
  operations.
- Preserve broad pattern boundary shapes (including schema defaults) so links to
  downstream `compute`/`handler`/`derive` code do not lose fields that are not
  directly read in the outer pattern callback.
- In pattern-style contexts, treat "lowerable to opaque/key semantics" as the
  primary legality criterion. Uses that cannot be lowered should produce
  diagnostics.

**Additional lowering target:**

- If a receiver is capability-classified as `OpaqueCell`, lower path navigation:
  - `foo.bar.baz` -> `foo.key("bar", "baz")`
  - `foo?.bar?.baz` -> `foo.key("bar", "baz")`
- Optional-chain path navigation should not force a data read when represented
  via `key(...)` traversal.
- Canonicalize destructured pattern-style parameters to a single receiver
  parameter plus synthesized key-bindings.
  - Example: `pattern(({ foo, bar }) => body)` ->
    `pattern((input) => { const foo = input.key("foo"); const bar = input.key("bar"); return body; })`
  - This also applies to callbacks rewritten to `mapWithPattern`.

**Rationale:**

- Current context/type heuristics are increasingly brittle for nested/synthetic
  boundaries.
- `OpaqueRef` type complexity leaks into policy in ways that are hard to reason
  about and hard to maintain.
- Least-capability boundary types make behavior and contracts explicit while
  reducing accidental overexposure.

**Acceptance criteria:**

1. Rewrite decisions for collection and conditional operators can be explained
   from `{context, receiver capability summary}`, not `OpaqueRef` heuristics.
2. Boundary schemas/types for compute-oriented boundaries (`derive`, `lift`,
   `handler`, compute-like callbacks) can be shrunk to used paths when no
   wildcard operations are present.
3. Wildcard/dynamic operations (`...obj`, `Object.keys`, `for..in`, `for..of`,
   unknown dynamic keys, serialization-like full traversal) conservatively
   disable path shrinking for affected roots.
4. Capability shrink is path-sensitive across local aliasing/reassignment within
   the analyzed function scope.
5. Opaque path navigation lowering (`prop` / optional-chain navigation ->
   `key(...)`) is deterministic and semantics-preserving.
6. Optional-call forms (for example `foo?.bar()`) are explicitly out of scope
   for key-lowering until modeled separately.
7. A feature gate exists for rollout and A/B fixture validation.
8. Destructured callback parameters in pattern-style contexts are lowered to
   non-destructured receiver parameters with explicit `key(...)` bindings.
9. Alias/nested destructuring (for example `{ bar: b }`, `{ user: { name } }`)
   maps to the correct key paths.
10. Unsupported destructuring features that require full-value materialization
    (`...rest`, computed binding keys, default initializers requiring
    undefined-check semantics) are either conservatively handled via explicit
    compute wrappers or diagnosed until modeled.
11. Pattern-context diagnostics are emitted when an expression/use-site cannot
    be represented under opaque/key lowering rules, rather than by separate
    legacy heuristic checks.
12. Pattern-context legality summaries do not widen from helper-callee reads
    (`g(input) { return f(input); }` does not inherit read paths observed in
    `f`).
13. Pattern-context emitted schemas retain broad shape/defaults rather than
    shrinking to local reads.
14. Compute-context boundary summaries are allowed to widen from helper-callee
    reads/writes when interprocedural summaries are enabled.

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
expression structure there unless a rewrite is strictly required for
correctness.

## P-007 Deterministic, Explainable Rules Over Heuristics

Choose small deterministic policies tied to context/operator class. Avoid
“expensive RHS” style heuristics where possible because they are harder to
predict and explain.

## P-008 Diagnostics Should Teach The Model

When disallowing expressions in pattern context, diagnostics should explain:

1. what context the user is in,
2. why direct computation is constrained there,
3. which compute-context wrapper to use.

## P-009 Least Capability At Boundaries

When a boundary type can be represented with less authority without losing
needed behavior, prefer the least-capability representation in compute-oriented
contexts. Pattern boundaries prioritize opaque contract continuity.

## P-010 Path-Sensitive Precision, Conservative Fallback

Use precise path-level shrinking when evidence is strong in compute context.
When analysis is ambiguous, fall back to broader types/shapes rather than
risking unsoundness.

## P-011 Pattern Legality Is Lowerability

In pattern context, if authored code can be lowered to explicit opaque/key
operations, it is legal. If it cannot be lowered soundly, it should be rejected
with diagnostics that explain the blocking construct and compute-context escape
hatch.

## P-012 Preserve Schema Continuity Across Pattern Boundaries

Pattern boundaries should not prune schema/default shape based solely on local
pattern reads. Downstream compute/handler links must continue to see expected
fields/defaults unless an explicit author opt-in narrowing model is introduced.

## Candidate Implementation Touchpoints

- `packages/ts-transformers/src/ast/reactive-context.ts`
- `packages/ts-transformers/src/ast/type-inference.ts`
  (`isReactiveArrayMapCall`)
- `packages/ts-transformers/src/transformers/opaque-ref-jsx.ts`
- `packages/ts-transformers/src/transformers/opaque-ref/emitters/binary-expression.ts`
- `packages/ts-transformers/src/transformers/opaque-ref/emitters/conditional-expression.ts`
- `packages/ts-transformers/src/closures/strategies/map-strategy.ts`
- `packages/ts-transformers/src/ast/call-kind.ts`
- `packages/ts-transformers/src/ast/dataflow.ts` (or successor capability graph)
- `packages/ts-transformers/src/ast/type-inference.ts`
- `packages/ts-transformers/src/ast/type-building.ts`
- validation messaging in
  `packages/ts-transformers/src/transformers/pattern-context-validation.ts`
- replacement/merge path for that validation in capability-lowering diagnostics
- schema emission in
  `packages/ts-transformers/src/transformers/schema-injection.ts`
- schema generation coupling in
  `packages/ts-transformers/src/transformers/schema-generator.ts`
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
  owner:
    | "pattern"
    | "render"
    | "array-map"
    | "computed"
    | "derive"
    | "action"
    | "lift"
    | "handler"
    | "standalone"
    | "unknown";
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

## S-007 Introduce A Dedicated Capability-Flow IR

**Current complexity:** expression-local dataflow exists, but not a dedicated
summary model for read/write/pass-through capability at boundaries.

**Recommendation:** add a first-class capability-flow IR per analyzed function:

1. origin roots (pattern params, lift/pattern outputs, callback params)
2. alias graph edges (assignment/destructure/rebind)
3. operation facts (`read(path)`, `write(path)`, `pass`, `unknown-read`,
   `unknown-write`)
4. boundary summaries (per root and per emitted callback/module boundary)

For `.map` callbacks, callback parameters are origin roots in pattern mode only
for map calls that resolve to `mapWithPattern` under policy. Non-rewritten
`.map` callbacks should not be promoted to pattern-origin roots.

## S-008 Centralize Capability Shrinking In One Summarizer

**Current complexity:** type shaping logic is distributed across closure/schema
helpers.

**Recommendation:** one summarizer should own:

1. capability class (`opaque`, `readonly`, `writeonly`, `cell`)
2. path set and wildcard flags
3. conversion to TypeNode/schema hints for downstream emitters

## S-009 Add A Receiver Path-Lowering Pass For OpaqueCell

**Current complexity:** property/optional-chain behavior is split across several
emitters and contextual checks.

**Recommendation:** add a targeted lowering step (or utility used by emitters)
that converts property navigation on capability-proven `OpaqueCell` receivers to
`key(...)` chains, with explicit exclusions for optional-call.

## S-010 Add A Shared Parameter Canonicalization Pass

**Current complexity:** destructuring behavior is encoded in multiple callback
transforms and depends on proxy-style access assumptions.

**Recommendation:** add one reusable canonicalization utility for pattern-style
callbacks:

1. rewrite parameter binding patterns to a single receiver identifier
2. synthesize stable local bindings via `receiver.key(...)`
3. preserve aliasing and nested paths
4. apply consistently to `pattern(...)` and rewritten `mapWithPattern` callbacks

## S-011 Unify Validation With Lowerability Analysis

**Current complexity:** a separate validation transformer enforces pattern
context constraints using heuristics that may diverge from lowering behavior.

**Recommendation:** generate pattern-context diagnostics from the same analysis
that decides opaque/key lowering. This removes split-brain behavior where code
is "valid per validator" but not lowerable, or vice versa.

## Proposed Implementation Path

## Phase 0: Lock Baseline And Prepare Rollout

**Status:** Landed

1. Add explicit characterization tests for current `.map` nested behavior and
   logical lowering behavior.
2. Add a transformer option gate for new policy path (for example
   `contextPolicyV2`) so rollout can be incremental.

**Exit criteria:** baseline green; feature gate available.

## Phase 1: Terminology Migration (Low-Risk)

**Status:** Partially landed

1. Update docs and diagnostics from “safe” to “compute/pattern” terms.
2. Keep existing function names internally if needed, but update user-facing
   text immediately.

**Exit criteria:** no user-facing “safe context” wording in transformer docs and
diagnostics.

## Phase 2: Context Classifier Introduction

**Status:** Landed

1. Implement `getReactiveContextInfo(node, checker)`.
2. Re-implement old helpers as wrappers over the new classifier to preserve
   compatibility.
3. Migrate a first consumer (`pattern-context-validation`) to classifier-first
   flow.

**Exit criteria:** one canonical context implementation; old helpers become thin
compatibility shims.

## Phase 3: Logical Operator Policy Rewrite

**Status:** Landed

1. Implement `shouldLowerLogicalInJsx`.
2. Refactor `emitBinaryExpression` to use policy matrix (remove expensive-RHS
   gating for policy-controlled paths).
3. Keep semantic equivalence checks via snapshots/fixtures.

**Exit criteria:** `&&`/`||` behavior determined by context matrix, not local
heuristics.

## Phase 4: `.map` Policy Simplification

**Status:** Landed (with standalone-function follow-up)

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

**Status:** Open

1. Introduce collection-method strategy abstraction with `map` as first method.
2. Define placeholder policy entries for future operators without enabling
   runtime behavior yet.

**Exit criteria:** architecture ready for `.filter` analog without repeating map
logic.

## Phase 6: Cleanup

**Status:** Partially landed

1. Remove superseded heuristic branches.
2. Delete or deprecate old context helper names once all consumers migrate.
3. Update behavior and goals specs to final terminology/policy.

**Exit criteria:** no dead-path fallback logic for replaced policies.

## Capability Dataflow Rollout Path

## Phase D0: Guardrails And Instrumentation

**Status:** Landed

1. Add feature gate (`capabilityDataflowV1`) and fixture split for old/new path.
2. Add characterization tests for tricky nested cases and current boundary
   types.

**Exit criteria:** dual-path test harness in place with stable baseline.

## Phase D1: Origin Tagging

**Status:** Landed (intraprocedural)

1. Tag analysis origins from:
   - pattern/lift/derive/handler/action callback parameters
   - results of `lift(...)` and `pattern(...)` invoked within pattern code
   - `.map` callback parameters only when that call site is selected for
     `mapWithPattern` rewrite
2. Persist origin identity through synthetic node creation via registry
   metadata.

**Exit criteria:** origins are queryable at any operator/boundary site.

## Phase D2: Local Alias/Reassignment Flow Graph

**Status:** Landed

1. Implement statement-level local flow tracking for:
   - direct assignment/reassignment
   - object/array destructuring
   - parameter rebinding aliases
2. Emit conservative "unknown" edges on unsupported constructs.
3. Add parameter canonicalization for pattern-style destructured inputs to
   explicit key-binding prologues.

**Exit criteria:** alias lineage is available for capability summarization.

## Phase D3: Operation Classification

**Status:** Landed

1. Classify operations per origin/path:
   - reads (`get`, comparisons, arithmetic, branch predicates, template use)
   - writes (`set`, `update`, `push`, `send`, mutation helpers)
   - pass-through (argument forwarding/return without local read/write)
2. Detect wildcard/full-shape triggers (`...`, `Object.keys`, dynamic unknown
   key access, broad iteration).
3. Emit "non-lowerable in pattern context" reason codes for constructs requiring
   diagnostics.

**Exit criteria:** per-origin fact sets are stable across fixtures.

## Phase D4: Boundary Capability And Shape Shrinking

**Status:** Landed

1. Produce boundary summaries:
   - `OpaqueCell` / `ReadonlyCell` / `WriteonlyCell` / `Cell`
   - used path tree + wildcard flags
2. Wire summaries into schema/type emission in schema-injection/generator path.

**Exit criteria:** emitted boundary type/schema changes match expected least
capability for covered fixtures.

## Phase D5: Policy Integration For Operator Rewrites

**Status:** Partially landed

1. Replace map/logical receiver classification inputs with capability summaries.
2. Remove remaining `OpaqueRef`-specific heuristic branches where superseded.
3. Start routing pattern-context validation diagnostics through lowering
   eligibility checks.

**Exit criteria:** operator rewrite matrix decisions are capability-backed.

## Phase D6: Opaque Path Navigation Lowering

**Status:** Landed

1. Lower `foo.bar.baz` and optional-chain path navigation to `foo.key(...)` when
   receiver summary is `OpaqueCell`.
2. Ensure optional-chain navigation lowering preserves no-throw behavior.
3. Keep optional-call excluded and diagnosed if needed.
4. Ensure destructured parameter lowering composes with path-navigation lowering
   without duplicate or conflicting rewrites.

**Exit criteria:** snapshot parity for supported forms and explicit handling of
unsupported optional-call cases.

## Phase D7: Interprocedural Summaries (Compute Context Focus)

**Status:** Partially landed

Implemented in current MVP:

1. Compute-context capability analysis reuses callee summaries through resolved
   function signatures with concrete function bodies.
2. Transitive read/write paths from helper callees propagate to caller compute
   boundaries.
3. Pattern-context legality summaries remain direct/local (no helper-driven
   widening).

Remaining work:

1. Expand/clarify interprocedural scope boundaries (for example unsupported
   declaration forms and cross-module behavior expectations).
2. Add dedicated fixture matrix for interprocedural edge cases and recursion
   boundaries.

**Exit criteria:** compute-context boundaries gain transitive precision across
supported helper calls, while pattern-context legality remains local-only,
without major compile-time regression.

## Phase D8: Default-On And Legacy Cleanup

**Status:** Partially landed

1. Flip `capabilityDataflowV1` to default after stabilization window.
2. Remove legacy branches tied to old `OpaqueRef` heuristics.
3. Update behavior spec to reflect new default behavior.
4. Retire or reduce legacy pattern-context validation passes once lowerability
   diagnostics are complete.

**Exit criteria:** new path is default, old path removed or hard-deprecated.

## Open Questions

1. Should ternary in compute context JSX also be preserved (no `ifElse`
   lowering), mirroring the proposed `&&`/`||` rule?
2. Do we want a strict “context policy matrix” test suite that all operator
   rewrites must satisfy before merge?
3. For path shrinking, which operations should immediately force wildcard shape
   fallback vs allow partial precision?
4. For compute context, what interprocedural scope is required in MVP
   (same-module direct calls only vs broader), given pattern-context signatures
   are intentionally direct/local?
