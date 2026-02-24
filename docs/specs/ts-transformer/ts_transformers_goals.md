# TS Transformers Goals

**Status:** Working goals (current understanding)  
**Date:** February 24, 2026  
**Package:** `@commontools/ts-transformers`  
**Related:**
- `docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md`
- `docs/specs/ts-transformer/ts_transformers_design_deltas.md`

## 1. Why This Package Exists

Pattern authors should be able to write natural TypeScript/JSX while the runtime
still receives explicit, structured dataflow artifacts needed for reactivity,
schema-driven execution, and policy enforcement.

`ts-transformers` is the compile-time bridge between:

1. author-friendly code
2. runtime-friendly explicit forms

## 2. Primary Product Goal

Convert idiomatic authored code into explicit reactive/runtime forms with
minimal author burden and maximal semantic fidelity.

In practice, this means:

1. preserve what authors mean
2. make implicit reactive boundaries explicit
3. emit actionable diagnostics when intent cannot be represented safely

## 3. Users And Their Outcomes

## 3.1 Pattern Authors

Authors should be able to:

1. write normal TS/JSX in patterns without manually threading schemas/captures
2. get clear diagnostics when using unsupported/reactively-invalid constructs
3. reason about transformed behavior without needing deep compiler internals

## 3.2 Runtime And Platform

The runtime should receive:

1. explicit schemas for significant boundaries (`pattern`, `derive`, `lift`,
   `handler`, `cell`, `wish`, `generateObject`, conditional helpers)
2. explicit closure capture params instead of hidden lexical captures
3. explicit control-flow helper calls where required by reactive semantics

## 3.3 Maintainers

Maintainers should have:

1. deterministic stage boundaries and order
2. behavior locked by fixtures and focused unit tests
3. architecture that supports incremental policy changes without total rewrites

## 4. Goal Set

## G-001 Natural Authoring, Explicit Runtime

Default authoring should stay idiomatic, but output should carry the explicit
shape needed for runtime execution and tracking.

## G-002 Semantic Preservation

Transformations must preserve JavaScript/TypeScript runtime semantics, including
short-circuit/value behavior for conditional operators.

## G-003 Context-Aware Reactivity

Rules should be context-driven (pattern-facing vs compute-facing code), not
globally uniform or accidentally heuristic.

## G-004 High-Quality Diagnostics

Diagnostics should identify:

1. what pattern was detected
2. why it is invalid in this context
3. the preferred author action

## G-005 Schema Fidelity With Graceful Degradation

Prefer precise schemas when type information is available. When precision is not
possible (for example, unresolved generics), degrade predictably without
crashing transformation.

## G-006 Explicit Closure Capture

Eliminate hidden closure dependencies in transformed runtime-critical paths by
making captures explicit in params objects/pattern wrappers.

## G-007 Deterministic, Explainable Rewrites

Given the same source and options, output should be stable, predictable, and
explainable via a small set of rules.

## G-008 Test-Anchored Behavior

Behavior changes should be intentional and visible through fixture/unit deltas,
not incidental side effects of refactors.

## G-009 Readable Transformed Output

Generated output is an operational artifact for debugging. Readability and
traceability are goals, not just parser validity.

## G-010 Nested Collection-Operator Semantics

Nested contexts must preserve a clear, deterministic operator policy,
especially for collection methods (`.map`, and in future analogously `.filter`,
etc.).

The key requirement is that rewrite policy follows the **active context at the
operator site**, not only the outer expression.

### Collection Operator Policy Matrix

| Active context at operator call | Receiver category | Goal policy |
| --- | --- | --- |
| Pattern context | reactive/opaque pattern-facing values | Rewrite to explicit reactive form (for `.map`, currently `mapWithPattern` + patternized callback) |
| Pattern context | plain JS arrays/values | No reactive rewrite |
| Compute context | cell-like values that still require reactive lifting (`Cell` / `Writable` / `Stream` / equivalents) | Rewrite |
| Compute context | values treated as plain/auto-unwrapped in compute callbacks | Do not rewrite |

This is the tricky case for `.map`: in pattern context we want broad rewrite
coverage for reactive receivers, while in compute context rewrites should be
narrow and type-driven.

For future operators (`.filter`, `.find`, etc.), the goal is to keep the same
matrix shape unless there is a semantics-specific reason to diverge.

## 5. Non-Goals

## NG-001 Security Boundary

The transformer is not a trust boundary and does not make authored code
"trusted." Security comes from sandbox/runtime architecture.

## NG-002 Full Program Verification

This package is not a whole-program theorem prover or full soundness checker
for all reactive misuse patterns.

## NG-003 Complete Type-System Perfection

Perfect schema inference for all TypeScript features is not required for useful
operation. Graceful fallback is acceptable.

## NG-004 Source-Level No-Op Transforming

Keeping output textually similar to input is not a goal if explicit runtime
forms are required. Semantic fidelity is higher priority than textual identity.

## NG-005 Performance Micro-Optimization Over Clarity

Reasonable compile-time performance matters, but correctness and explainability
take priority over opaque micro-optimizations.

## 6. Constraints And Invariants

## C-001 Explicit Opt-In

Transform-heavy behavior is opt-in via `/// <cts-enable />`.

## C-002 Ordered Multi-Stage Pipeline

Stage order is part of behavior. Reordering is a design change requiring
explicit validation.

## C-003 Shared Cross-Stage Registries

Type and metadata propagation across stages (`typeRegistry`, callback markers,
schema hints, diagnostics) is intentional and required for fidelity.

## C-004 Best-Effort On Synthetic Nodes

Synthetic nodes are unavoidable. The system should keep behavior stable using
registry fallbacks and robust node handling.

## C-005 Runtime Contract Compatibility

Transforms must target runtime helper contracts as implemented (not idealized
future contracts).

## C-006 Context Transitions In Nested Code

Nested callbacks can cross context boundaries. The effective rewrite policy must
switch when entering a new callback context, then switch back when exiting.

Examples of required behavior:

1. Pattern callback -> nested compute callback: compute-context policy applies
   inside the nested callback.
2. Compute callback -> nested reactive collection callback: collection rewrite
   decision is evaluated at that nested operator/callback site, not inherited
   blindly from the parent.
3. Context shifts introduced by earlier transformer passes (for example JSX
   rewriting introducing synthetic compute wrappers) are treated as real context
   boundaries for downstream collection-operator decisions.

## 7. Success Criteria

We are meeting goals when:

1. authors can write canonical pattern code without manual schema/capture
   plumbing
2. diagnostics are specific and lead directly to corrected code
3. fixture churn is intentional and tied to documented policy changes
4. known unsupported patterns fail clearly, not silently at runtime
5. transformed output supports practical debugging and code review
6. nested context tests demonstrate the collection-operator policy matrix for
   `.map` and any newly added analogous operators

## 8. Policy For Future Changes

When evaluating a transformer change:

1. state which goals it improves (`G-*`)
2. state which invariants it touches (`C-*`)
3. identify any non-goal drift (`NG-*`)
4. include fixture/unit evidence
5. update behavior and delta docs together

## 9. Current Strategic Direction

Near-term direction implied by the current delta backlog:

1. move terminology from “safe context” toward semantic context naming
2. make conditional-operator rewrite policy context-driven and coherent
3. prioritize deterministic rules over local heuristics where possible
