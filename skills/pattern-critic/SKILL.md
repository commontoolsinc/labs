---
name: pattern-critic
description: Critic agent that reviews pattern code for violations of documented rules, gotchas, and anti-patterns. Produces categorized checklist output with [PASS]/[FAIL] for each rule.
---

Start with the shared critique guidance in:

- `docs/common/ai/pattern-critique-guide.md`

Read that guide first. It is the canonical reference.

Be explicit about SES and determinism issues: direct `Date.now()` or
`Math.random()`, authored timers, and non-idempotent `computed()` use of
`safeDateNow()` or `nonPrivateRandom()` should all be flagged.

Then use the detailed references already maintained in the repo for:

- `docs/development/debugging/README.md`
- `docs/development/debugging/gotchas/`
- `docs/common/components/COMPONENTS.md`
- `docs/common/patterns/ui-cookbook.md`
- `docs/common/capabilities/llm.md` - LLM integration

## Quick Patterns

### Correct action() Usage (Default Choice)

```typescript
// action() inside pattern body - closes over pattern variables
export default pattern<MyInput, MyOutput>(({ items, title }) => {
  const menuOpen = Writable.of(false);

  // Action closes over menuOpen - no binding needed
  const toggleMenu = action(() => menuOpen.set(!menuOpen.get()));

  // Action closes over items - no binding needed
  const addItem = action(() => items.push({ title: title.get() }));

  return {
    [UI]: (
      <>
        <cf-button onClick={toggleMenu}>Menu</cf-button>
        <cf-button onClick={addItem}>Add</cf-button>
      </>
    ),
    items,
  };
});
```

### Correct handler() Usage (Only for Multi-Binding)

```typescript
// handler() at module scope - will be bound with different items in .map()
const deleteItem = handler<
  void,
  { item: Writable<Item>; items: Writable<Item[]> }
>(
  (_, { item, items }) => {
    const list = items.get();
    items.set(list.filter((i) => i !== item));
  },
);

export default pattern<MyInput, MyOutput>(({ items }) => ({
  [UI]: (
    <ul>
      {items.map((item) => (
        <li>
          {item.name}
          {/* Each item gets its own binding */}
          <cf-button onClick={deleteItem({ item, items })}>Delete</cf-button>
        </li>
      ))}
    </ul>
  ),
  items,
}));
```

### Correct Reactive [NAME]

```typescript
export default pattern<Input>(({ deck }) => ({
  [NAME]: computed(() => `Study: ${deck.name}`),
  // ...
}));
```

### Correct Conditional Rendering

```typescript
// Prefer plain ternaries in normal pattern code
return <>{showDetails ? <div>Details content</div> : null}</>;
```

### Visual Review Reminder

When UI is important to the pattern, also look for:

- weak visual hierarchy
- poor grouping or spacing rhythm
- neglected empty or first-run states
- styling that ignores available public component affordances
