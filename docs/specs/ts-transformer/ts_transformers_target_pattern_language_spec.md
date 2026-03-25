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
| Receiver-method calls inside safe wrappers or callback-local owned sites | Supported | Receiver methods are valid when another supported owner already establishes the semantic boundary, such as JSX expression sites, `computed`/`derive` callbacks, or rewritten collection callbacks |
| Event-handler JSX attributes | Supported | Event handlers form an explicit callback boundary; they are part of the language but not part of ordinary expression-site lowering |
| Dynamic key access inside safe owners or structural binding forms | Supported | Dynamic access like `selectedScopes[key]` is valid when it lives inside a supported owner (`computed`, JSX expression sites, lowered callbacks, etc.) or lowers directly through a structural binding form |
| Bare dynamic key access in top-level pattern-facing code | Unsupported | Forms like `input[key]` as a direct top-level pattern-body traversal are outside the intended declarative language and should move into `computed`, `derive`, or another safe wrapper |
| Cell-style `.key(...)` traversal on explicitly cell-like values | Supported | When the authored value is truly `Cell`/`Writable`/`Stream`-like, `.key(...)` remains part of that value's direct API rather than an implementation artifact |
| Cell-style `.get()` reads on explicitly cell-like values inside supported owners | Supported | Eager cell reads remain valid inside safe owners like `computed`, `derive`, JSX expression sites, and other callback contexts that preserve declared cell semantics |
| Foreign callback / imperative container roots in JSX | Unsupported | Shapes like `[0, 1].forEach(() => list.map(...))` are not part of the intended reactive language core and should move into supported value expressions, wrappers, or helpers |
| Residual callback-container pass-through behavior for invalid programs | Compatibility-only | Some invalid callback-container shapes may still survive as plain JS in current emitted output, but that is residual implementation behavior rather than supported language policy |
| Optional-call on reactive receivers | Unsupported | Optional-call forms are outside the intended language because they are difficult to lower without semantic ambiguity |
| Direct non-JSX receiver-method calls on reactive values in pattern bodies | Unsupported | These should be moved into `computed`, `derive`, helper control flow, or another safe wrapper instead of being treated as first-class pattern-body syntax |
| Direct top-level `.get()` reads in pattern-owned reactive context | Unsupported | Even on true cell-like values, eager `.get()` reads should move into a safe owner such as `computed`, helper control flow, or JSX rather than living directly in the top-level declarative pattern body |
| `.get()` on ordinary opaque/reactive values | Unsupported | Pattern inputs, `computed` results, `derive` results, and other ordinary reactive values should be read directly rather than through `.get()` |
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

## 5.4 Callback-Container Pass-Through Is Not A Language Goal

If a construct is only supportable by compatibility behavior such as:

1. leaving the foreign container authored as plain JS
2. or, in older/rarer cases, wrapping the whole foreign container as one
   compute/derive island

that is strong evidence it should be rejected from the target language rather
than elevated into the core language.

That is the current stance for callback-container roots and similar imperative
foreign wrappers. They are not a target-language abstraction; they are
unsupported. If current invalid programs still pass through as plain JS, that
is residual implementation behavior, not target-language policy.

## 5.5 Dynamic Key Access Is Ownership-Split

Dynamic key access is not one single language category.

The intended split is:

1. **dynamic access inside a supported owner or structural binding form**
   - allowed when another supported owner already establishes the semantic
     boundary, or when the access lowers directly through a binding form that
     preserves the dynamic key structurally
   - examples:
     - `computed(() => input[key])`
     - JSX-local `{input[key]}`
     - JSX-local derived checkbox bindings
     - callback-local wrapped expressions
     - captured dynamic element access inside rewritten collection callbacks
     - computed binding-key destructuring like `({ [key]: foo }) => ...`
2. **bare top-level pattern traversal**
   - not part of the target language
   - examples:
     - direct `input[key]` in a top-level pattern body expression

This is why the target-language matrix treats the two forms differently.

## 5.6 Receiver-Method Calls Are Ownership-Split

Receiver-method calls are also not one single language category.

The intended split is:

1. **direct top-level non-JSX pattern-body receiver calls**
   - not part of the target language
   - examples:
     - `{ upper: state.name.toUpperCase() }`
     - `const upper = identity(state.name.trim())` in top-level pattern code
2. **receiver-method calls inside an already-supported owner**
   - valid as part of that owner's language
   - examples:
     - JSX expression sites like `{state.name.toUpperCase()}`
     - `computed(() => state.name.toUpperCase())`
     - callback-local calls inside rewritten collection operators

So the language should not be read as “receiver methods are unsupported.” The
real rule is that **bare top-level pattern-body receiver calls are unsupported
as a standalone pattern construct**.

## 5.7 `.key(...)` And `.get()` Are Cell-Semantics-Split

Path-terminal cell-style APIs should not be described as one coarse bucket.

The intended split is:

1. **true cell-style traversal**
   - `.key(...)` on explicitly declared `Cell` / `Writable` / `Stream`-like
     values is part of the authored language
   - example:
     - `input.key("foo")` where `input` is a declared `Writable<{ ... }>`
2. **true cell-style eager read inside a safe owner**
   - `.get()` remains valid when the authored value truly has cell semantics
     and the read occurs inside an owner that is allowed to perform eager
     computation
   - examples:
     - `computed(() => input.key("foo").get())`
     - JSX expression sites like `{input.key("foo").get()}`
     - `lift` / `handler` / `action` / `derive` callbacks that preserve
       declared cell semantics
3. **direct top-level eager read in pattern-owned reactive context**
   - not part of the target language, even for true cells
   - example:
     - `{ value: input.key("foo").get() }` directly in a top-level pattern body
4. **`.get()` on ordinary opaque/reactive values**
   - not part of the target language
   - examples:
     - `input.get()` where `input` is an ordinary pattern value
     - `computedResult.get()`

So the language should not be read as “`.get()` / `.key()` are transitional.”
The real rule is:

- `.key(...)` is a real source-level API for true cell-like values
- `.get()` is valid only when both the value semantics and the ownership
  context justify an eager read
- ordinary opaque/reactive values should still prefer direct property access
  and canonical lowered traversal rather than authored `.get()`

## 6. Immediate Classification Questions To Refine Next

These families should be the first explicit follow-up questions for v2:

1. whether the supported dynamic-key bucket is now phrased clearly enough in
   author-facing terms, or still leaks too much implementation detail about
   owners and wrappers
2. whether the current receiver-method split is the right long-term boundary, or
   whether any narrow direct non-JSX receiver-method forms deserve promotion
3. whether the remaining invalid-program callback-container pass-through should
   be removed from implementation once diagnostics are in place
4. whether the current explicit-cell `.key(...)` / `.get()` boundary is the
   right long-term authored API surface, or whether it should be narrowed or
   documented more aggressively relative to ordinary opaque/property access

## 7. Use This Spec

When a construct is hard to classify cleanly, do not paper over the difficulty.
Instead ask:

1. is this really part of the intended language?
2. is the implementation boundary still leaking through?
3. should this be reworked, demoted to compatibility-only, or rejected
   outright?

That is the intended role of this document: to make those decisions explicit.
