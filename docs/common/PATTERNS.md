<!-- @reviewed 2025-12-11 docs-rationalization -->

# Common Patterns

Patterns for building CommonTools applications, organized by complexity.

## Core Principles

### 1. Use computed() for Data Transformations

Reactive references in pattern bodies need `computed()` for transformations - direct iteration or operations will fail. Wrap transformations in `computed()`:

```typescript
// ❌ WRONG
const grouped = {};
for (const entry of entries) {  // Error: reactive reference needs computed()
  grouped[entry.date] = entry;
}

// ✅ CORRECT
const grouped = computed(() => {
  const result = {};
  for (const entry of entries) {
    result[entry.date] = entry;
  }
  return result;
});
```

### 2. Only Declare Writable<> When You Need to Mutate

Everything is reactive by default. `Writable<>` in type signatures indicates you'll call `.set()`, `.push()`, or `.update()`:

```typescript
interface Input {
  count: number;             // Read-only (still reactive!)
  items: Writable<Item[]>;   // Will mutate (call .push(), .set())
}
```

### 3. Prefer Bidirectional Binding Over Handlers

Before writing a handler, ask: "Am I just syncing UI ↔ data?"

```typescript
// ✅ SIMPLE - No handler needed
<ct-checkbox $checked={item.done} />
<ct-input $value={item.name} />

// Use handlers only for side effects, validation, or structural changes
```

---

## Levels: Progressive Examples

The following examples are complete, self-contained patterns illustrating progressive complexity. For real working patterns, see `packages/patterns/`.

## Level 1: Basic List

The simplest pattern: a list with bidirectional binding and inline handlers.

```typescript
import { Cell, Default, NAME, pattern, UI, Writable } from "commontools";

interface Item {
  title: string;
  done: Default<boolean, false>;
}

interface Input {
  items: Writable<Item[]>;
}

export default pattern<Input, Input>(({ items }) => ({
  [NAME]: "Shopping List",
  [UI]: (
    <div>
      {items.map((item) => (
        <div style={{ display: "flex", gap: "8px" }}>
          <ct-checkbox $checked={item.done}>
            <span style={item.done ? { textDecoration: "line-through" } : {}}>
              {item.title}
            </span>
          </ct-checkbox>
          <ct-button onClick={() => {
            const current = items.get();
            const index = current.findIndex((el) => Cell.equals(item, el));
            if (index >= 0) items.set(current.toSpliced(index, 1));
          }}>×</ct-button>
        </div>
      ))}
      <ct-message-input
        placeholder="Add item..."
        onct-send={(e) => {
          const text = e.detail?.message?.trim();
          if (text) items.push({ title: text, done: false });
        }}
      />
    </div>
  ),
  items,
}));
```

**Key points:**
- `$checked` automatically syncs - no handler needed
- Inline handlers for add/remove operations
- **Uses `Cell.equals()` for item identity**
- Ternary in `style` attribute works fine
- Type inference works in `.map()` - no annotations needed

---

## Level 2: Derived Views

Add `computed()` for data transformations:

```typescript
import { computed, Default, NAME, pattern, UI } from "commontools";

interface Item {
  title: string;
  done: Default<boolean, false>;
  category: Default<string, "Other">;
}

interface Input {
  items: Default<Item[], []>;
}

export default pattern<Input, Input>(({ items }) => {
  const grouped = computed(() => {
    const groups: Record<string, Item[]> = {};
    for (const item of items) {
      const cat = item.category || "Other";
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(item);
    }
    return groups;
  });

  const categories = computed(() => Object.keys(grouped).sort());

  return {
    [NAME]: "By Category",
    [UI]: (
      <div>
        {categories.map((cat) => (
          <div>
            <h3>{cat}</h3>
            {(grouped[cat] ?? []).map((item) => (
              <ct-checkbox $checked={item.done}>{item.title}</ct-checkbox>
            ))}
          </div>
        ))}
      </div>
    ),
    items,
  };
});
```

**Key points:**
- `computed()` creates reactive transformations
- Direct property access: `grouped[cat]`
- Inline null coalescing: `(grouped[cat] ?? [])`

---

## Level 3: Linked Charms

Separate patterns sharing data through charm linking:

```bash
# Deploy both charms
deno task ct charm new ... editor.tsx   # Returns: editor-id
deno task ct charm new ... viewer.tsx   # Returns: viewer-id

# Link their data
deno task ct charm link ... editor-id/items viewer-id/items
```

Changes in the editor automatically appear in the viewer.

### Cross-Charm Mutations

Direct writes to another charm's cells fail with `WriteIsolationError`. Use `Stream.send()`:

```typescript
// Charm B: Expose a stream for receiving updates
interface Input {
  items: Writable<Item[]>;
  addItem: Stream<{ title: string }>;
}

export default pattern<Input>(({ items, addItem }) => {
  addItem.subscribe(({ title }) => {
    items.push({ title, done: false });
  });
  // ...
});

// Charm A: Send to Charm B's stream
const add = handler((_, { linkedStream }) => {
  linkedStream.send({ title: "New" }, { onCommit: () => console.log("Sent!") });
});
```

---

## Level 4: Pattern Composition

Multiple patterns sharing data within a single charm:

```typescript
import ShoppingList from "./shopping-list.tsx";
import CategoryView from "./category-view.tsx";

export default pattern<Input, Input>(({ items }) => {
  const listView = ShoppingList({ items });
  const catView = CategoryView({ items });

  return {
    [NAME]: "Both Views",
    [UI]: (
      <div style={{ display: "flex", gap: "2rem" }}>
        <div>{listView}</div>
        <div>{catView}</div>
      </div>
    ),
    items,
  };
});
```

Both patterns receive the same `items` cell - changes sync automatically.

**When to use which:**
- **Pattern Composition**: Multiple views in one UI, reusable components
- **Linked Charms**: Independent deployments that communicate

---

## Making Charms Discoverable

Export a `mentionable` property to make child charms appear in `[[` autocomplete:

```typescript
export default pattern<Input, Output>(({ ... }) => {
  const childCharm = ChildPattern({ ... });

  return {
    [NAME]: "Parent",
    [UI]: <div>...</div>,
    mentionable: [childCharm],  // Makes childCharm discoverable via [[
  };
});
```

For dynamic collections, use a Cell:

```typescript
const createdCharms = Cell.of<any[]>([]);

const create = handler((_, { createdCharms }) => {
  createdCharms.push(ChildPattern({ name: "New" }));
});

return {
  [UI]: <ct-button onClick={create({ createdCharms })}>Create</ct-button>,
  mentionable: createdCharms,  // Cell is automatically unwrapped
};
```

**Notes:**
- Exported mentionables appear in `[[` autocomplete
- They do NOT appear in the sidebar charm list
- Use this instead of writing to `allCharms` directly

---

## Quick Reference

### When to Use What

| Need | Use |
|------|-----|
| Toggle checkbox | `$checked` (bidirectional) |
| Edit text | `$value` (bidirectional) |
| Add/remove from array | Inline handler |
| Complex/reusable logic | `handler()` |
| Transform data | `computed()` |
| Filter/sort lists | `computed()` |
| Cross-charm mutation | `Stream.send()` |
| Make charm discoverable | Export `mentionable` |
| Expand/collapse UI | Native `<details>/<summary>` |

**Tip: Native HTML for Expand/Collapse**

Use native `<details>/<summary>` instead of custom state + handlers:

```typescript
// ✅ Simple, accessible, no state management needed
<details>
  <summary style={{ cursor: "pointer" }}>Click to expand</summary>
  <div>Hidden content here</div>
</details>
```

Only use custom state if you need programmatic control (e.g., "expand all" button).

### Writable<> in Type Signatures

| Type | Meaning |
|------|---------|
| `items: Item[]` | Read-only, reactive |
| `items: Writable<Item[]>` | Read + write (will mutate) |
| `items: Default<Item[], []>` | Optional with default |

### Handler Type Signatures

```typescript
const myHandler = handler<EventType, StateType>((event, state) => { ... });
//                        ^^^^^^^^^  ^^^^^^^^^
//                        1st param  2nd param (passed at invocation)
```

**The state type defines what you pass when invoking:**

```typescript
// Handler with mixed primitives and Cells
const fireShot = handler<
  unknown,  // event type (often unused for UI handlers)
  { row: number; col: number; game: Cell<GameState> }
>((_, { row, col, game }) => {
  const state = game.get();
  // row and col are plain numbers, game is a Cell
});

// Invocation - pass values matching state type
<div onClick={fireShot({ row: 3, col: 5, game })} />
```

**Type annotations are required** - without them, handler parameters become `any`.

### action() - Simplified Handlers

For inline handlers where all data is in scope at definition time:

```typescript
// action - data bound at definition (closes over count)
action(() => count.set(count.get() + 1))

// handler - data bound at invocation (row, col passed per-call)
handler<unknown, { row: number; col: number; game: Cell<Game> }>(...)
```

Use `handler()` when you need to pass data at invocation time (e.g., loop variables). Use `action()` for simple inline mutations where everything needed is already in scope.

<!-- TODO: Expand action() documentation -->

---

## Common Mistakes

### Direct Data Access

```typescript
// ❌ Error: reactive reference outside reactive context
for (const entry of entries) { ... }

// ✅ Wrap in computed()
const result = computed(() => {
  for (const entry of entries) { ... }
});
```

### Forgetting $ Prefix

```typescript
// ❌ One-way only - changes don't sync back
<ct-checkbox checked={item.done} />

// ✅ Bidirectional binding
<ct-checkbox $checked={item.done} />
```

### Filter/Sort Not Updating

```typescript
// ❌ WRONG: Inline filtering in JSX won't update reactively
{items.filter(i => !i.done).map(...)}

// ✅ CORRECT: Compute outside JSX, then map over the result
const active = computed(() => items.filter(i => !i.done));
{active.map(...)}  // You CAN map over computed() results!
```

### Template String Access

```typescript
// ❌ Error: reactive reference from outer scope
const prompt = `Seed: ${seed}`;

// ✅ Wrap in computed()
const prompt = computed(() => `Seed: ${seed}`);
```

### lift() Closure Pattern

```typescript
// ❌ Error: reactive reference from outer scope cannot be accessed via closure
const result = lift((g) => g[date])(grouped);

// ✅ Pass all reactive dependencies as parameters
const result = lift((args) => args.g[args.d])({ g: grouped, d: date });

// ✅ Or use computed() instead (handles closures automatically)
const result = computed(() => grouped[date]);
```

See [REACTIVITY.md](REACTIVITY.md) section "lift() and Closure Limitations" for details on frame-based execution and why `computed()` doesn't have this issue.

### Style Syntax

```typescript
// ✅ HTML elements - Object syntax
<div style={{ flex: 1 }} />

// ✅ Custom elements - String syntax
<ct-card style="flex: 1;" />
```

### Conditional Rendering

```typescript
// ❌ Ternary for elements doesn't work
{show ? <div>Content</div> : null}

// ✅ Use ifElse()
{ifElse(show, <div>Content</div>, null)}

// ✅ Ternary IS fine for attributes
<span style={done ? { textDecoration: "line-through" } : {}}>
```

### Handlers Inside Conditional Branches

**Important:** Inside conditional branches (`ifElse()` or ternary), cells become opaque proxies. Inline closures that access cells will fail:

```typescript
// ❌ FAILS inside ifElse - "Tried to directly access an opaque value"
{ifElse(
  showButtons,
  <ct-button onClick={() => counter.set(counter.get() + 1)}>Inc</ct-button>,
  null
)}

// ❌ ALSO FAILS with ternary - same error
{showButtons ? (
  <ct-button onClick={() => counter.set(counter.get() + 1)}>Inc</ct-button>
) : null}

// ✅ WORKS - Pass cells as handler state params
const increment = handler<unknown, { cell: Cell<number> }>(
  (_, { cell }) => cell.set(cell.get() + 1)
);

{ifElse(
  showButtons,
  <ct-button onClick={increment({ cell: counter })}>Inc</ct-button>,
  null
)}
```

**Why:** The transformer has closure extraction for `.map()`, `computed()`, and `handler()`, but not for conditional branches. This is a known limitation.

**The rule:** Inside conditional branches (`ifElse()` or ternary), always use `handler()` with explicit cell params. In all other contexts (top-level, `.map()`, `computed()`), inline closures work fine.

### onClick in computed()

```typescript
// ❌ Causes ReadOnlyAddressError
const ui = computed(() => (
  <ct-button onClick={handler}>Click</ct-button>
));

// ✅ Keep buttons at top level, use disabled for conditional
<ct-button disabled={!isReady} onClick={handler}>Click</ct-button>
```

### React Differences

CommonTools uses Lit for rendering, not React. Key differences:

```typescript
// ❌ key prop causes compiler error - not needed
{items.map(item => <div key={item.id}>{item.name}</div>)}

// ✅ No key needed - Lit handles reconciliation differently
{items.map(item => <div>{item.name}</div>)}
```

---

## Development Workflow

```bash
# Check syntax (fast)
deno task ct dev pattern.tsx --no-run

# Test locally
deno task ct dev pattern.tsx

# Deploy
deno task ct charm new ... pattern.tsx

# Update existing (faster iteration)
deno task ct charm setsrc ... --charm CHARM_ID pattern.tsx

# Inspect data
deno task ct charm inspect ... --charm CHARM_ID
```

**Tips:**
- Use `dev` first to catch TypeScript errors
- Deploy once, then use `setsrc` for updates
- Test one feature at a time

---

## See Also

- [REACTIVITY.md](REACTIVITY.md) - Deep dive on reactivity
- [COMPONENTS.md](COMPONENTS.md) - UI component reference
- [TYPES_AND_SCHEMAS.md](TYPES_AND_SCHEMAS.md) - Type system details
- [DEBUGGING.md](DEBUGGING.md) - Troubleshooting guide
