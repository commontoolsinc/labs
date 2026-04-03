# Pattern Critique Guide

This is the canonical reference for reviewing Common Fabric patterns.

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

| Violation | Fix |
|-----------|-----|
| `handler()` defined inside pattern | Move to module scope, or use `action()` instead |
| `lift()` immediately invoked (`lift(...)(args)`) | Use `computed()` or define lift at module scope |
| helper functions defined inside pattern | Move to module scope |

Allowed inside patterns:

- `computed()`
- `action()`
- `.map()` callbacks
- JSX event handlers

### 2. Reactivity

| Violation | Fix |
|-----------|-----|
| `[NAME]: someProp` | `[NAME]: computed(() => someProp)` |
| `[NAME]: \`text ${someProp}\`` | `[NAME]: computed(() => \`text ${someProp}\`)` |
| `Writable.of(reactiveValue)` | Initialize empty, set in handler or action |
| `.get()` on computed or lift result | Access directly; only `Writable` uses `.get()` |
| `items.filter(...)` inline in JSX | Wrap in `computed()` outside JSX |
| `items.sort(...)` inline in JSX | Wrap in `computed()` outside JSX |
| nested computed with outer-scope reactive vars | Pre-compute with lift or an outer computed |
| `lift()` closing over reactive deps | Pass dependencies as explicit parameters |
| cells from composed patterns in `ifElse` | Wrap in a local `computed()` bridge |

### 3. Conditional Rendering

| Violation | Fix |
|-----------|-----|
| `onClick` or conditional UI inside `computed()` | Move the interactive element outside and use direct JSX conditionals |

Ternaries are valid in JSX. The transformer auto-converts them to `ifElse()`.

### 4. Type System and Data Shape

| Violation | Fix |
|-----------|-----|
| array without `Default<T[], []>` where undefined would be invalid | Add a sensible default |
| missing `Writable<>` wrapper on values later mutated | Add `Writable<T>` to the relevant type |
| `Map` or `Set` in serialized cell data | Use plain objects or arrays |
| custom identity field where `equals()` is intended | Use `equals()` instead of ad hoc identity |

### 5. Binding

| Violation | Fix |
|-----------|-----|
| `checked={item.done}` | `$checked={item.done}` |
| `value={title}` | `$value={title}` |
| `$checked={item}` | `$checked={item.done}` |
| wrong event name | Use `onct-send`, `onct-input`, or `onct-change` |

### 6. Custom component props

Check that custom component props use the correct camelCase names.

| Violation | Fix |
|-----------|-----|
| kebab-case props on `ct-*` | Use camelCase, for example `allowCustom` |

### 7. Handler Binding

| Violation | Fix |
|-----------|-----|
| state bound where runtime event data should be used | Bind only stable state and let event data arrive at runtime |
| handlers created repeatedly inside `.map()` | Create one shared handler and bind item-specific data |

### 8. Stream and Async Usage

| Violation | Fix |
|-----------|-----|
| `Stream.of()` | It does not exist; the bound handler is the stream |
| `.subscribe()` on a stream | Return the stream from the pattern instead |
| `async/await` in handlers | Use reactive APIs such as `fetchData()` instead |
| `await generateText(...)` | Use `.result` |
| `await generateObject(...)` | Use `.result` |

### 9. LLM Integration

| Violation | Fix |
|-----------|-----|
| array schema at the root of `generateObject` | Wrap it in an object such as `{ items: T[] }` |
| missing `/// <cts-enable />` | Add it at the top of the file |
| prompt derived from agent-written cells | Split the source cells to avoid loops |
| invalid model-name format | Use `vendor:model` |

### 10. Performance

| Violation | Fix |
|-----------|-----|
| handler created per item inside a loop | Create a shared handler and bind per item |
| expensive computation embedded directly in render loops | Pre-compute outside the loop |

### 11. Action vs Handler Choice

Prefer `action()` by default. Use `handler()` when different data must be bound
to different handler instantiations.

Fail when:

- `handler()` is used with no multi-binding need
- `action()` is created per item in a `.map()` and should be a shared handler

| Violation | Fix |
|-----------|-----|
| `handler()` used with no multi-binding scenario | Convert to `action()` inside the pattern body |
| `handler()` when all instantiations use the same data | Convert to `action()` |
| `action()` inside `.map()` creating one action per item | Use `handler()` at module scope with binding |

When to use `action()`:

- the handler is specific to one pattern
- it closes over pattern-scope variables
- all instantiations use the same closed-over data

When to use `handler()`:

- different data must be bound per instantiation
- the same handler implementation is reused in multiple places
- you are binding per-item behavior in `.map()`

### 12. Design Review

| Check | What to look for |
|-------|------------------|
| clear entity boundaries | each pattern represents one concept |
| actions match user intent | handler names match what the user wants to do |
| unidirectional data flow | parents own state, children receive props |
| normalized state | no duplicate data, single source of truth |
| self-documenting types | type names and field names are clear without comments |
| appropriate granularity | neither too fine nor too coarse |

### 13. Regression Check

| Check | What to verify |
|-------|----------------|
| tests still pass | existing tests run cleanly after the change |
| type signatures preserved | or intentionally migrated with a clear reason |
| handlers still work | existing functionality is not broken |
| no unintended side effects | changes stay scoped to the intended area |

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
