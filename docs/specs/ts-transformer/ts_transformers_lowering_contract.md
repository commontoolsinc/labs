# TypeScript Transformers Lowering Contract

**Status:** Candidate v1 (normative semantic contract for current hardening phase)\
**Package:** `@commonfabric/ts-transformers`\
**Related:**

- `docs/specs/ts-transformer/ts_transformers_target_pattern_language_spec.md`
- `docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md`
- `docs/specs/ts-transformer/ts_transformers_goals.md`

## 1. Purpose

This document defines the semantic obligations of the transformer system when it
does rewrite supported pattern-language constructs.

It is intentionally narrower than a full implementation spec. The point is to
state **what must be preserved**, not to freeze the current module layout or
pipeline internals.

For supported target-language constructs, this contract is the source of truth.
If current implementation behavior disagrees, fix the implementation or record
the divergence in descriptive docs rather than weakening the contract.

## 2. Contract Scope

This contract applies to lowering of supported reactive expression constructs,
especially:

- reactive control flow
- reactive collection operators
- property/element access over reactive values
- wrapper introduction (`derive`, `computed`, helper control-flow forms)
- callback capture and ownership lowering

## 3. Semantic Invariants

## 3.1 Control-Flow Semantics Must Be Preserved

Lowering of `?:`, `&&`, `||`, and related helper-owned control flow must
preserve authored JavaScript meaning:

1. the same branch must be selected
2. the same short-circuit behavior must hold
3. the resulting value semantics must match authored code

In particular, the compiler must not silently replace value-level control flow
with truthiness of an opaque proxy/ref object.

## 3.2 Parentheses Must Not Change Reactive Meaning

Equivalent nested control-flow expressions must lower equivalently regardless of
superficial parenthesization.

If:

- `a ? b : c ? d : e`

and:

- `a ? b : (c ? d : e)`

mean the same thing as authored JS, they must not differ only because one shape
was rewritten structurally and the other was left raw.

## 3.3 Crossing Context Boundaries Must Be Explicit

An outer rewrite must not silently root-rewrite through a nested reactive
context boundary such as:

- `computed(...)`
- `derive(...)`
- `action(...)`
- `handler(...)`
- rewritten collection callbacks

Nested callbacks may be traversed according to their own rules, but an outer
site must not rewrite them as though they were part of the same ownership
region.

## 3.4 Call-Target Shape Must Be Preserved

Lowering must not change call shape in a way that alters receiver binding or
callee evaluation order.

In particular, a rewrite must not transform:

- `obj[key](arg)`

into a semantically different shape like:

- `(someWrapper(obj[key]))(arg)`

unless that new shape is explicitly proven equivalent.

Whole-call wrapping is acceptable when it preserves authored callee semantics.

## 3.5 Collection Operator Ownership Must Stay Coherent

For collection operators:

1. if a call is structurally owned and rewritten (for example to
   `mapWithPattern`), its callback becomes a pattern-like opaque callback
   boundary
2. if a call is not structurally rewritten, its callback stays ordinary JS for
   that context

The compiler must not accidentally mix these models for the same operator site.

## 3.6 Chain Ownership Must Be Single-Owner

Receiver chains must have one coherent owner:

1. **structural owner**
   - recurse structurally through the relevant operator/callback chain
2. **sink owner**
   - whole-wrap the chain as one reactive expression unit

The compiler should not partly whole-wrap and partly independently lower the
same chain in ways that make ownership reasoning ambiguous.

## 3.7 Captures Must Be Explicit And Minimal

When lowering introduces a wrapper callback:

1. all semantically relevant reactive dependencies must be captured
2. nested function-local or plain-array callback locals must not be captured by
   outer reactive wrappers
3. closure lowering must not leak callback-local bindings into outer wrapper
   scopes

This is a semantic requirement, not merely an output readability preference.

## 3.8 Dynamic Access Must Either Lower Safely Or Diagnose

Dynamic key access over reactive values is valid only when the compiler can
represent it safely.

So the compiler must do one of two things:

1. lower the minimal containing expression with correct captures and value
   semantics
2. emit a clear diagnostic that the construct is not lowerable in that context

Silent half-lowering is not acceptable.

## 3.9 Unsupported Constructs Must Fail Clearly

When the language boundary is exceeded, the compiler should prefer:

1. an explicit diagnostic

over:

2. leaving a construct in a semantically misleading partially lowered state

This is especially important for:

- optional-call
- wildcard traversal outside supported whole-call expression-root positions
- foreign callback-container roots in pattern-facing contexts
- direct top-level eager `.get()` reads on reactive or cell-like values
- imperative statement-boundary constructs in top-level pattern context

## 3.10 Phase Choice Is An Implementation Detail

Some constructs may be routed pre-closure and others post-closure, but that
phase choice is not itself part of the language contract.

The semantic contract is:

1. supported authored constructs should lower equivalently regardless of which
   internal phase owns them
2. phase boundaries should exist to preserve semantics and maintainability, not
   to create user-visible special cases

## 4. Non-Normative Implementation Interpretation

The current implementation realizes this contract through:

1. validation transformers
2. early JSX routing
3. computed/closure normalization
4. shared ownership-first lowering
5. shared expression-rewrite backend
6. final capability/schema layers

But these layers are explanatory only. The contract above is the normative
piece.

## 5. Use This Contract

When evaluating a bug, refactor, or new construct, ask:

1. which invariant would be violated if this lowering were wrong?
2. is the construct part of the supported target language?
3. should the implementation be clarified, or should the construct be demoted
   out of the language?

That question ordering is deliberate:

- first the language
- then the semantic contract
- then the implementation
