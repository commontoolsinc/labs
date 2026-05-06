---
name: pattern-implement
description: Build Common Fabric patterns and sub-patterns
user-invocable: false
---

Use the `cf` skill, or read `skills/cf/SKILL.md`, for CLI documentation when
running commands.

# Implement Pattern

## Core Rule

Match the implementation mode to the task.

For Pattern Factory Build, implement the top-level pattern deliverable described
by the brief, spec, UX design, and UI design. Use sub-patterns only when they
make the implementation clearer.

For an isolated sub-pattern task, write one sub-pattern with minimal UI first so
data flow can be verified before polish.

**Always use `pattern<Input, Output>()`** - expose actions as `Stream<T>` for
testability.

## Order

1. Leaf patterns first (no dependencies on other patterns)
2. Container patterns (compose leaf patterns)
3. main.tsx last (composes everything)

## Read First

- `docs/common/ai/pattern-factory-build-guide.md` - when working in a Pattern
  Factory Build workspace
- `docs/common/concepts/reactivity.md` - Cell behavior, reactive values, and
  `.get()` / `.set()` boundaries
- `docs/common/patterns/new-cells.md` - when and how to create pattern-owned
  writable cells with static initial values
- `docs/common/ai/pattern-development-guide.md` - especially the SES authoring
  limits and escape-hatch guidance
- `docs/common/patterns/` - especially `meta/` for generalizable idioms
- `docs/common/concepts/action.md` - action() for local state
- `docs/common/concepts/handler.md` - handler() for reusable logic
- `docs/common/concepts/identity.md` - equals() for object comparison

For Pattern Factory Build, do not start implementation until you have read the
Build guide plus the two foundational reactivity/local-cell references above.

## Key Patterns

**action()** - Closes over local state in pattern body:

```tsx
const inputValue = Writable.of("");
const submit = action(() => {
  items.push({ text: inputValue.get() });
  inputValue.set("");
});
```

Use `Writable.of()` only for pattern-owned local cells initialized from static
values. Do not pass an input prop, mapped field, computed value, or other
reactive value into `Writable.of()`. If the pattern receives writable state, use
that input cell directly; if a draft needs to copy from input state, copy in an
action or another valid reactive/event context.

For Pattern Factory Build, this rule applies to the top-level pattern input
object too. Do not initialize local state with `Writable.of(input.name || "")`,
`Writable.of(input.items || [])`, `Cell.of(input.field)`, or helper calls around
`input.field`. First decide whether each field is primary pattern state, static
local UI state, or draft/editing state:

- Primary pattern state: expose it in the `Input`/`Output` contract with
  `Default<>` and `Writable<>` as needed, then use the reactive input directly.
- Static local UI state: create it with `Writable.of(...)` from static literals
  only.
- Draft/editing state: create it from a static value, then copy from input state
  inside an `action()` or another valid event/reactive context.

Use `safeDateNow()` and `nonPrivateRandom()` instead of ambient `Date.now()` and
`Math.random()` when a pattern needs explicit time or randomness. If a control
is already bound to a cell, usually via `$value` or `$checked`, let that binding
own the control value. Use `oncf-change` / `oncf-input` only for dependent state
or other side effects.

Do not invoke streams or writes while assigning JSX event props. For example,
`onClick={selectItem.send(index)}` runs during render; use
`onClick={() => selectItem.send(index)}` or a bound `handler()` instead. This is
especially important inside `.map()` bodies because render-time writes can make
`raw:map` non-idempotent.

**handler()** - Reused with different bindings:

```tsx
const deleteItem = handler<void, { items: Writable<Item[]>; index: number }>(
  (_, { items, index }) => items.set(items.get().toSpliced(index, 1)),
);
// In JSX: onClick={deleteItem({ items, index })}
```

**Rendering sub-patterns** - Use function calls, not JSX:

```tsx
// ✅ Correct
return <>{items.map((item) => ItemPattern({ item, allItems: items }))}</>;

// ❌ Wrong - JSX fails with typed Output
return <>{items.map((item) => <ItemPattern item={item} />)}</>;
```

## Done When

- Pattern compiles: `deno task cf check pattern.tsx --no-run`
- The top-level UI or sub-pattern UI renders the behavior needed for the task
- Ready for testing
