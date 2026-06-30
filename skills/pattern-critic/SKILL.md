---
name: pattern-critic
description: Critic agent that reviews pattern code for violations of documented rules, gotchas, and anti-patterns. Produces categorized checklist output with [PASS]/[FAIL]/[WARN] for each rule.
---

Start with the shared critique guidance in:

- `docs/common/ai/pattern-critique-guide.md`

Read that guide first. It is the canonical reference. Severity definitions
(`critical`/`major`/`minor`/`info`) live in the guide; use them as defined
there.

Whatever else happens, honor the output contract: emit the guide's
[PASS]/[FAIL]/[WARN] categorized checklist and end with the Summary counts and
the Priority Fixes list. If nothing fails, say so explicitly in two lines. Write
the review to the output path you were given (in the factory:
`reviews/critic-NN.md`).

Be explicit about SES and determinism issues. Flag direct `Date.now()` or
`Math.random()`, authored timers, and any call — including `safeDateNow()` /
`nonPrivateRandom()` — made inside a re-running `computed()`/`lift()` without
clear intent (non-idempotent use). Also flag bound-control self-feedback: if a
`cf-*` form control is already bound to a cell, usually via `$value` or
`$checked`, treat an event handler that writes the same value back into that
same cell as a reactive-loop hazard unless it is clearly necessary and
idempotent.

Also run the guide's advisory UI-idiom checks (category 15): hardcoded hex
colors and inline typography in `style=`, `.set()`-only input handlers,
hand-rolled Enter-key submit, index-based selection state, and hand-rolled
badge/field/empty-state markup. Those emit as `[WARN]` and count toward the
Warnings summary line, never Failed.

Then use the detailed references already maintained in the repo for:

- `docs/development/debugging/README.md`
- `docs/development/debugging/gotchas/`
- `docs/common/components/COMPONENTS.md`
- `docs/common/patterns/ui-cookbook.md`
- `docs/common/capabilities/llm.md` - LLM integration
- `docs/common/capabilities/fetch.md` - fetch builtins
  (fetchJson/fetchText/fetchBinary)

## Quick Patterns

### Correct action() Usage (Default Choice)

```typescript
// action() inside pattern body - closes over pattern variables
export default pattern<MyInput, MyOutput>(({ items, title }) => {
  const menuOpen = new Writable(false);

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

### Scoped State Review

Review whether each state field has the right sharing boundary. A useful test
for UI state: if the user opens the same instance in a new tab, should this
state carry over? If not, it is probably `PerSession<>`.

| State                                                                                                     | Expected scope |
| --------------------------------------------------------------------------------------------------------- | -------------- |
| shared records, rooms, documents, canonical task lists                                                    | `PerSpace<>`   |
| display name, user preference, personal draft, account-local setting                                      | `PerUser<>`    |
| navigation, selected tab, selected item, selected room, modal/open state, local filter text, focused item | `PerSession<>` |

Flag these issues:

| Violation                                                      | Fix                                                                                                                                 |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| transient UI state stored as unscoped or shared space state    | Use `PerSession<>`                                                                                                                  |
| user-owned state stored as shared space state                  | Use `PerUser<>`                                                                                                                     |
| shared canonical content stored per-session                    | Use `PerSpace<>` unless isolation is intentional                                                                                    |
| user ids or session ids embedded in data to simulate isolation | Use scope wrappers                                                                                                                  |
| `PerAny<>` used where the inner scope is known                 | Replace with the known scope; reserve `PerAny<>` for intentionally scope-polymorphic inner values under an outer `Per*` declaration |
| scope used as an authorization boundary                        | Keep CFC/IFC/security policy separate                                                                                               |

Accept either scoped authoring style:

```ts
// Plain data-shaped inputs.
conversation?: PerSpace<Conversation | Default<typeof DEFAULT_CONVERSATION>>;
name?: PerUser<string | Default<"">>;
selectedRoom?: PerSession<SelectedRoom | Default<{}>>;

// Writable aliases when handlers need stable cell handles.
name?: PerUser<Writable<string | Default<"">>>;
selectedRoom?: PerSession<Writable<SelectedRoom | Default<{}>>>;
```

`PerAny<>` should normally appear only as an inner override, for example:

```ts
type Selection = PerSession<{
  item: PerUser<Item>;
  attachment: PerAny<Attachment>;
}>;
```

### Visual Review Reminder

When UI is important to the pattern, also look for:

- weak visual hierarchy
- poor grouping or spacing rhythm
- neglected empty or first-run states
- styling that ignores available public component affordances
