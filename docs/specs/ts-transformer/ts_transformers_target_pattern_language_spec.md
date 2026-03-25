# TypeScript Transformers Target Pattern Language Specification

**Status:** Draft v1 (normative target language)\
**Package:** `@commontools/ts-transformers`\
**Related:**

- `docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md`
- `docs/specs/ts-transformer/ts_transformers_lowering_contract.md`
- `docs/specs/ts-transformer/ts_transformers_goals.md`

## 1. Purpose

This document defines the **intended authored pattern language** that the
transformer pipeline should support.

It is not a file-by-file description of the current implementation. Instead, it
answers:

1. what authors should be allowed to write
2. which constructs are first-class parts of the language
3. which constructs are merely tolerated compatibility behavior
4. which constructs are outside the language and should diagnose clearly

If this document and the current implementation disagree, treat the difference
as a design question to resolve. Do not silently let implementation accident
become language policy.

## 2. Scope

This v1 draft focuses on the **reactive expression language inside patterns**:

- JSX expression sites
- helper-owned control flow (`ifElse`, `when`, `unless`)
- collection operators over reactive receivers
- direct reactive property/element access
- pattern-body expression forms that interact with ownership-first lowering

It does **not** attempt to restate every validation rule in the package. The
existing current-behavior spec remains the descriptive inventory for those
details.

## 3. Status Labels

Each construct family is classified as one of:

- **Supported**
  - first-class part of the intended language
- **Transitional**
  - currently supported and likely to remain, but the exact formulation or
    boundary may still tighten
- **Compatibility-only**
  - tolerated behavior for existing code, but not something we want to bless as
    a core target-language construct
- **Unsupported**
  - outside the intended language; should fail clearly or remain explicitly out
    of scope

## 4. Core Language Matrix

| Construct family | Status | Intended meaning |
| --- | --- | --- |
| Reactive property access in JSX or helper-owned expressions | Supported | Authored reactive reads like `state.user.name` should remain natural and lower to explicit reactive access as needed |
| Reactive element access with static or known-symbol keys | Supported | Forms like `items[0]`, `item[NAME]`, `state["foo"]` should lower predictably when the access path is statically representable |
| Reactive control flow in JSX (`?:`, `&&`, `||`, `??`) | Supported | Reactive conditions and branch values should preserve authored JavaScript control-flow meaning |
| Authored helper control flow (`ifElse`, `when`, `unless`) | Supported | These are first-class reactive control-flow forms, not mere implementation helpers |
| `map` / `filter` / `flatMap` on reactive receivers in pattern-facing contexts | Supported | These operators are core language forms and may be structurally rewritten to explicit reactive collection operators |
| Callback-local plain JS arrays in rewritten callbacks | Supported | Plain JS arrays inside callbacks stay plain; they are not implicitly promoted into pattern-owned array operators |
| Direct JSX sink chains over structural array results | Supported | Terminal sink chains like `.filter(...).join(", ")` and ordinary receiver-method chains above that sink are valid JSX expression forms |
| Event-handler JSX attributes | Supported | Event handlers form an explicit callback boundary; they are part of the language but not part of ordinary expression-site lowering |
| Dynamic key access inside lowerable expression sites | Transitional | Dynamic access like `selectedScopes[key]` is valid when the containing expression can be safely wrapped; support outside such sites is intentionally narrower |
| Direct path-terminal calls like `.get()` / `.key()` on true cell-like values | Transitional | These remain allowed where their underlying cell semantics require them, but they are not the preferred pattern-facing style for ordinary opaque pattern values |
| Foreign callback / imperative container roots in JSX | Compatibility-only | Shapes like `[0, 1].forEach(() => list.map(...))` may still work, but they are not part of the intended language core |
| Residual callback-container whole-wrap behavior | Compatibility-only | Whole-container wrapping for foreign callback roots is compatibility behavior, not a target-language abstraction |
| Optional-call on reactive receivers | Unsupported | Optional-call forms are outside the intended language because they are difficult to lower without semantic ambiguity |
| Direct non-JSX receiver-method calls on reactive values in pattern bodies | Unsupported | These should be moved into `computed`, `derive`, helper control flow, or another safe wrapper instead of being treated as first-class pattern-body syntax |
| Statement-boundary imperative constructs in top-level pattern-owned code (`let`, loops, function creation, early return) | Unsupported | Top-level pattern context is intentionally declarative; imperative statement structure belongs in safe wrapper callbacks |

## 5. Construct Notes

## 5.1 JSX Is A Routing Boundary, Not A Separate Semantic World

JSX is part of the authored language, but it is not a privileged semantic
universe. The intended model is:

1. JSX sites may require special routing because of phase/ownership concerns
2. the semantics supported inside JSX should otherwise match the same language
   rules we would want outside JSX

Any rule that is hard to state without saying “because JSX” is a sign that the
implementation boundary may still need cleanup.

## 5.2 Helper Control Flow Is Part Of The Language

`ifElse`, `when`, and `unless` are not merely output artifacts. They are part of
the intended reactive source language as well:

- authors may write them directly
- the compiler may also lower ordinary JS control flow into them

So the language should treat authored helper control flow and lowered helper
control flow as semantically aligned.

## 5.3 Collection Operators Are Contextual

The same method names do not mean the same thing in every context.

The intended rule is:

1. on reactive receivers in pattern-facing contexts, `map` / `filter` /
   `flatMap` are language operators and may be structurally rewritten
2. on plain JS arrays or compute-owned plain values, the same methods stay
   ordinary JS

This distinction is part of the language, not an incidental optimizer detail.

## 5.4 Whole-Wrap Compatibility Is Not A Language Goal

If a construct is only supportable by “wrap this whole foreign container in one
derive/compute island and hope for the best,” that is strong evidence it should
be classified as compatibility-only rather than elevated into the core language.

That is the current stance for callback-container roots and similar imperative
foreign wrappers.

## 6. Immediate Classification Questions To Refine Next

These families should be the first explicit follow-up questions for v2:

1. dynamic key access outside JSX/expression-local wrappers
2. whether any direct non-JSX receiver-method forms deserve promotion from
   unsupported to supported
3. whether any compatibility-only callback-container shapes should instead be
   diagnosed and removed from the language boundary
4. the exact intended status of path-terminal `.get()` / `.key()` usage in
   authored pattern code

## 7. Use This Spec

When a construct is hard to classify cleanly, do not paper over the difficulty.
Instead ask:

1. is this really part of the intended language?
2. is the implementation boundary still leaking through?
3. should this be reworked, demoted to compatibility-only, or rejected
   outright?

That is the intended role of this document: to make those decisions explicit.
