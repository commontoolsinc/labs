# Pattern Critique Guide

This is the agent-neutral reference for reviewing Common Fabric patterns.

## Review Goals

A pattern review should check:

- documented convention violations
- correctness and robustness risks
- reactivity and data-flow issues
- maintainability and cohesion
- regressions when modifying existing code

Reviews should produce line-referenced findings where practical, concrete fix
guidance, and a short priority list at the end.

## Violation Categories

### 1. Module Scope

Check that these are not inside the pattern body:

- `handler()` definitions that should be at module scope
- immediately invoked `lift(...)`
- helper functions that should live at module scope

Allowed inside patterns:

- `computed()`
- `action()`
- `.map()` callbacks
- JSX event handlers

### 2. Reactivity

Look for:

- reactive values used directly where a computed wrapper is required
- string interpolation over reactive values without `computed()`
- `Writable.of(reactiveValue)`
- `.get()` used on computed or lift results
- inline `filter()` or `sort()` in JSX where the work should be precomputed
- nested computed closures that capture unstable outer reactive state
- `lift()` closing over reactive dependencies instead of taking parameters
- composed pattern cells used in `ifElse` without a local computed bridge

### 3. Conditional Rendering

Look for event handlers or reactive gates placed inside `computed()` when the
UI should instead use direct JSX conditionals.

### 4. Type System and Data Shape

Look for:

- arrays without sensible defaults when undefined would be invalid
- missing `Writable<>` wrappers on values that are later mutated
- `Map` or `Set` used in serialized cell data
- custom identity fields when `equals()` would be the intended mechanism

### 5. Binding

Check:

- `$checked` and `$value` usage for reactive props
- property-level binding instead of whole-object binding
- correct event names such as `onct-send`, `onct-input`, and `onct-change`

### 6. Style Syntax

HTML elements require object style syntax. Custom `ct-*` elements require
string style syntax. Also check that custom component props use the correct
camelCase names.

### 7. Handler Binding

Look for:

- state being bound where runtime event data should be used
- handlers created repeatedly inside `.map()` when a shared handler plus
  binding would be cleaner

### 8. Stream and Async Usage

Look for:

- nonexistent `Stream.of()`
- `.subscribe()` assumptions on streams
- `async/await` in handlers where reactive APIs are expected
- `await generateText(...)` or `await generateObject(...)` where `.result`
  should be used

### 9. LLM Integration

Look for:

- array schemas at the root of `generateObject`
- missing `/// <cts-enable />`
- prompts derived from agent-written cells that can cause loops
- invalid model-name formats

### 10. Performance

Look for:

- handler creation per item inside loops
- expensive computation embedded directly in render loops

### 11. Action vs Handler Choice

Prefer `action()` by default. Use `handler()` when different data must be bound
to different handler instantiations.

Fail when:

- `handler()` is used with no multi-binding need
- `action()` is created per item in a `.map()` and should be a shared handler

### 12. Design Review

Check:

- clear entity boundaries
- actions that match user intent
- unidirectional data flow
- normalized state
- self-documenting type and field names
- appropriate granularity

### 13. Regression Check

When reviewing updates to existing patterns, verify:

- tests still pass
- type signatures are preserved or intentionally migrated
- existing handlers still work
- changes are scoped to the intended area

## Output Format

The review should be emitted as a structured checklist with explicit pass/fail
calls, for example:

```text
## Pattern Review: main.tsx

### 1. Module Scope
- [PASS] No handler() inside pattern
- [FAIL] lift() immediately invoked (line 23)
  Fix: Use computed() or move lift to module scope

### 2. Reactivity
- [PASS] [NAME] properly wrapped
- [FAIL] Writable.of(deck.name) uses reactive value (line 15)
  Fix: Initialize empty, set in action()

...

## Summary
- Passed: 22
- Failed: 3
- Warnings: 1
- N/A: 2

## Priority Fixes
1. [Line 15] Writable.of() with reactive value
2. [Line 23] lift() inside pattern
3. [Line 45] Missing $ prefix on binding
```

## Severity and Prioritization

Use the shared severity taxonomy from the factory protocol:

- `critical`
- `major`
- `minor`
- `info`

For modify-mode pre-build reviews, findings should also be easy for an
orchestrator to triage into:

- correctness or divergence risks that are `MUST-FIX`
- style or taste observations that are `NOTED`

Every non-trivial finding should include:

- line number or precise location
- why it matters
- what to change

## Useful References

- `docs/development/debugging/README.md`
- `docs/development/debugging/gotchas/`
- `docs/common/components/COMPONENTS.md`
- `docs/common/capabilities/llm.md`
