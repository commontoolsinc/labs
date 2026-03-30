# TypeScript Transformers Target Pattern Language Specification

**Status:** Candidate v1 (normative target language for current hardening phase)\
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

If this document and the current implementation disagree on a supported or
unsupported construct family, treat the implementation as needing correction or
an explicitly recorded follow-up in the design-deltas/current-behavior docs. Do
not silently let implementation accident become language policy.

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
| Receiver-method calls inside JSX expressions, explicit computation callbacks, or authored helper control flow | Supported | Receiver methods are valid in local authored expression contexts such as JSX interpolation, `computed` / `derive` / `action` / `lift` / `handler` callbacks, and helper control flow branches like `ifElse(show, name.trim(), "fallback")` |
| Event-handler JSX attributes | Supported | Event handlers form an explicit callback boundary; they are part of the language but not part of ordinary expression-site lowering |
| Dynamic key access inside JSX expressions, explicit computation callbacks, supported collection callbacks, or structural binding forms | Supported | Dynamic access like `selectedScopes[key]` is valid in local authored expression contexts or in binding forms that preserve the dynamic key directly |
| Bare dynamic key access in top-level pattern-facing code | Unsupported | Forms like `input[key]` as a direct top-level pattern-body traversal are outside the intended declarative language and should move into JSX, an explicit computation callback, a supported collection callback, or a structural binding form |
| Cell-style `.key(...)` traversal on explicitly cell-like values | Supported | When the authored value is truly `Cell`/`Writable`/`Stream`-like, `.key(...)` remains part of that value's direct API rather than an implementation artifact |
| Cell-style `.get()` reads on explicitly cell-like values inside JSX expressions, authored helper control flow, or explicit computation callbacks | Supported | Eager cell reads remain valid when authored in JSX interpolation, helper control flow such as `ifElse` / `when` / `unless`, and explicit computation callbacks such as `computed`, `derive`, `action`, `lift`, and `handler` |
| Foreign callback / imperative container roots in JSX | Unsupported | Shapes like `[0, 1].forEach(() => list.map(...))` are not part of the intended reactive language core and should move into supported value expressions, wrappers, or helpers |
| Residual callback-container pass-through behavior for invalid programs | Compatibility-only | Some invalid callback-container shapes may still survive as plain JS in current emitted output, but that is residual implementation behavior rather than supported language policy |
| Optional-call on reactive receivers | Unsupported | Optional-call forms are outside the intended language because they are difficult to lower without semantic ambiguity |
| Direct non-JSX receiver-method calls on reactive values in top-level pattern-body expression sites | Supported | Value-like receiver-method roots at top-level object-property, call-argument, variable-initializer, array-element, or return-expression sites lower to derived local value expressions |
| Direct receiver-method roots inside supported collection callbacks | Supported | Callback-local value-like receiver-method roots lower to callback-local `derive(...)` expressions instead of remaining raw or requiring manual wrapper calls |
| Direct top-level `.get()` reads in pattern-owned reactive context | Unsupported | Even on true cell-like values, eager `.get()` reads should move into JSX or an explicit computation callback such as `computed`, `derive`, `action`, `lift`, or `handler` rather than living directly in the top-level declarative pattern body |
| `.get()` on ordinary opaque/reactive values | Unsupported | Pattern inputs, `computed` results, `derive` results, and other ordinary reactive values should be read directly rather than through `.get()` |
| Statement-boundary imperative constructs in top-level pattern-owned code (`let`, loops, function creation, early return) | Unsupported | Top-level pattern context is intentionally declarative; imperative statement structure belongs in explicit callback bodies such as `computed`, `action`, `lift`, or `handler` |

## 4.1 Authoring Context Guide

The matrix above is the policy summary. This section states the same boundary
in author-facing terms: **what kinds of expressions belong in each authored
context.**

### Top-Level Pattern Body

The top-level pattern body should stay declarative.

**Good here**

```ts
pattern(({ items, show }) => ({
  upper: items[0].name.toUpperCase(),
  visibleCount: ifElse(show, items.length, 0),
  [UI]: <div>{items.map((item) => item.name)}</div>,
}));
```

**Move elsewhere**

```ts
pattern(({ user, count }) => ({
  value: count.get(),
}));
```

Why:

- top-level helper control flow is part of the language
- top-level receiver-method roots are supported at lowerable non-JSX
  expression sites
- eager `.get()` reads still move into JSX, authored helper control flow, or an explicit
  computation callback

### JSX Expressions

JSX is the main local reactive expression context.

**Good here**

```tsx
<div>
  {user.name.toUpperCase()}
  {selectedScopes[key]}
  {ifElse(show, count.get(), 0)}
  {items.filter((item) => item.visible).join(", ")}
</div>
```

**Unsupported here**

```tsx
<div>{[0, 1].forEach(() => list.map((item) => item))}</div>
```

Why:

- JSX supports local reactive reads, control flow, receiver methods, supported
  collection callbacks, and true-cell eager reads
- JSX does not bless foreign imperative callback containers as language forms

### Explicit Computation Callbacks

`computed`, `derive`, `action`, `lift`, and `handler` callbacks are explicit
imperative/value-computation boundaries.

**Good here**

```ts
computed(() => input[key])
computed(() => count.get())
action(() => state.name.trim())
```

**Still unsupported here**

```ts
computed(() => derivedValue.get())
```

Why:

- dynamic access, receiver methods, and true-cell eager reads are valid here
- `.get()` on ordinary opaque/reactive values is still not part of the
  language, even inside a computation callback

### Event Handler JSX Attributes

Event handlers are an explicit callback boundary for imperative UI logic.

**Good here**

```tsx
<button onClick={() => count.set(count.get() + 1)} />
```

Why:

- imperative statements and eager reads belong naturally inside the event
  handler callback boundary
- event handlers are part of the language, but they are not ordinary
  expression-site lowering roots

### Supported Collection Callbacks

Callbacks for supported reactive collection operators are their own authored
expression context.

**Good here**

```ts
items.map((item) => item.name)
items.map((item) => item.toUpperCase())
items.map((item) => identity(item.toUpperCase()))
items.map((item) => ifElse(item.active, item.name, "hidden"))
items.map((item) => <span>{item.name.toUpperCase()}</span>)
```

Why:

- the outer callback belongs to the supported reactive collection operator
- structural access, receiver-method value expressions, helper control flow,
  and nested JSX-local expressions are valid here
- inner plain arrays stay plain JS and are not implicitly promoted into
  pattern-owned collection operators

## 4.2 Common Relocation Patterns

When an authored form is unsupported, the right answer is usually to move it
into a context that already has a clear language meaning.

### Top-Level Eager `.get()` -> Helper Control Flow Or Computation Callback

**Avoid**

```ts
pattern(({ count }) => ({
  value: count.get(),
}));
```

**Prefer**

```ts
pattern(({ count, show }) => ({
  value: ifElse(show, count.get(), 0),
}));
```

or:

```ts
pattern(({ count }) => ({
  value: computed(() => count.get()),
}));
```

### Bare Dynamic Key Access -> JSX, Callback, Or Structural Binding

**Avoid**

```ts
pattern(({ selectedScopes, key }) => ({
  value: selectedScopes[key],
}));
```

**Prefer**

```tsx
pattern(({ selectedScopes, key }) => ({
  [UI]: <div>{selectedScopes[key]}</div>,
}));
```

or:

```ts
pattern(({ selectedScopes, key }) =>
  computed(() => selectedScopes[key])
);
```

### Foreign Callback Container -> Supported Wrapper Or Helper

**Avoid**

```tsx
<div>{[0, 1].forEach(() => list.map((item) => item))}</div>
```

**Prefer**

```tsx
<div>{computed(() => list.map((item) => item))}</div>
```

or move the imperative container entirely outside the pattern-facing expression
site into a named helper or handler.

### Optional-Call -> Explicit Nullish Control Flow

**Avoid**

```ts
pattern(({ maybeFn, value }) => ({
  result: maybeFn?.(value),
}));
```

**Prefer**

```ts
pattern(({ maybeFn, value }) => ({
  result: computed(() => maybeFn == null ? undefined : maybeFn(value)),
}));
```

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

## 5.4 Callback / Container Boundary Is Four-Way Split

The callback/container boundary should be read in four distinct buckets:

1. **supported reactive collection callbacks**
   - examples:
     - `items.map((item) => item.name)`
     - `items.map((item) => item.toUpperCase())`
   - why:
     - the callback belongs to a supported language operator over a supported
       receiver family
2. **supported terminal sink chains over structural array values**
   - examples:
     - `<div>{items.filter((item) => item.visible).join(", ")}</div>`
     - `<div>{items.map((item) => item.name).join(", ")}</div>`
   - why:
     - these are still value expressions over structural array results, not
       foreign callback-container roots
3. **unsupported foreign callback / imperative container roots**
   - examples:
     - `<div>{[0, 1].forEach(() => list.map((item) => item))}</div>`
     - `<div>{somePromise.then(() => list.map((item) => item))}</div>`
   - why:
     - the outer wrapper is not a target-language operator or local value
       expression context; it is a foreign imperative container
4. **compatibility-only residual pass-through for invalid programs**
   - meaning:
     - if a shape from bucket 3 still survives as plain JS in current emitted
       output, that is residual implementation behavior rather than language
       policy

This is why callback-container pass-through is not a language goal. If a
construct is only supportable by compatibility behavior such as:

1. leaving the foreign container authored as plain JS
2. or, in older/rarer cases, wrapping the whole foreign container as one
   compute/derive island

that is strong evidence it should be rejected from the target language rather
than elevated into the core language.

One important nuance: an explicit wrapper like `computed(() => list.map(...))`
is supported because `computed` creates a supported computation boundary around
an inner value expression. That does **not** make foreign containers like
`forEach(...)` or `then(...)` themselves part of the language.

## 5.5 Dynamic Key Access Is Context-Split

Dynamic key access is not one single language category.

The intended split is:

1. **dynamic access inside local expression contexts or structural binding
   forms**
   - allowed when written inside JSX expressions, explicit computation
     callbacks, supported collection callbacks, or a binding form that
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

## 5.6 Receiver-Method Calls Are Context-Split

Receiver-method calls are also not one single language category.

The intended split is:

1. **direct top-level non-JSX pattern-body receiver calls**
   - part of the target language at lowerable top-level expression sites
   - examples:
     - `{ upper: state.name.toUpperCase() }`
     - `const upper = identity(state.name.trim())` in top-level pattern code
2. **receiver-method calls inside explicit local expression contexts**
   - valid as part of those local expression contexts
   - examples:
     - JSX expression sites like `{state.name.toUpperCase()}`
     - `computed(() => state.name.toUpperCase())`
     - `action(() => state.name.trim())`
     - `ifElse(show, state.name.trim(), "fallback")`
     - `items.map((item) => item.toUpperCase())`
     - `items.map((item) => identity(item.toUpperCase()))`
3. **optional-call / ambiguous receiver-call forms**
   - still outside the target language
   - examples:
     - `input?.foo()`
     - `items.map((item) => item?.toUpperCase())`

So the language should not be read as “receiver methods are unsupported.” The
real rule is that **receiver methods are supported in explicit local expression
contexts, inside supported collection callbacks, and at lowerable top-level
non-JSX pattern sites, but optional-call receiver forms remain unsupported**.
Optional property / element access follows the ordinary lowerable
expression-site rules; only optional-call forms remain outside the target
language.

## 5.7 `.key(...)` And `.get()` Are Cell-Semantics-Split

Path-terminal cell-style APIs should not be described as one coarse bucket.

The intended split is:

1. **true cell-style traversal**
   - `.key(...)` on explicitly declared `Cell` / `Writable` / `Stream`-like
     values is part of the authored language
   - example:
     - `input.key("foo")` where `input` is a declared `Writable<{ ... }>`
2. **true cell-style eager read inside JSX, authored helper control flow, or an explicit computation callback**
   - `.get()` remains valid when the authored value truly has cell semantics
     and the read occurs inside JSX, helper control flow, or an explicit
     computation callback
   - examples:
     - `computed(() => input.key("foo").get())`
     - JSX expression sites like `{input.key("foo").get()}`
     - `ifElse(show, count.get(), 0)`
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
- `.get()` is valid only when both the value semantics and the authored
  expression context justify an eager read, including helper control flow
- ordinary opaque/reactive values should still prefer direct property access
  and canonical lowered traversal rather than authored `.get()`

One important nuance: there are still transform-only continuity tests around
explicitly typed `Writable` / `Cell` inputs and top-level `.key(...).get()`
reads. Those tests preserve schema/input-shape behavior for invalid programs,
but they do **not** promote direct top-level eager reads into the supported
target language while validation still rejects them.

## 6. Non-Normative Hardening Follow-Ups

These are implementation/documentation follow-ups, not unresolved v1 language
questions:

1. remove residual invalid-program callback-container pass-through where
   feasible; until then it remains compatibility-only and may disappear without
   language change
2. keep the explicit-cell `.key(...)` / `.get()` boundary documented
   consistently across diagnostics, examples, and specs; any future narrowing
   would be a later language revision rather than an unresolved v1 semantic
3. preserve typed-input/schema continuity tests around explicit cell-like
   inputs without promoting direct top-level `.get()` reads into the language
4. keep optional-call on reactive receivers unsupported in v1 unless a future
   language revision defines an explicit evaluation model

## 7. Use This Spec

When a construct is hard to classify cleanly, do not paper over the difficulty.
Instead ask:

1. is this really part of the intended language?
2. is the implementation boundary still leaking through?
3. should this be reworked, demoted to compatibility-only, or rejected
   outright?

That is the intended role of this document: to make those decisions explicit.
If current implementation behavior still differs, record that as a follow-up in
the descriptive docs rather than softening this spec by accident.
