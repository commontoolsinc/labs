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

### Child Modifying Parent State

When a child pattern needs to modify parent state (and survive serialization for
trash/restore), pass parent Cells as INPUT parameters:

```typescript
// Parent passes its Cell to child
const picker = ChildModule({ parentItems: items });

// Child receives Cell and can modify it
interface ChildInput { parentItems: Cell<Item[]>; }

export const ChildModule = pattern<ChildInput>(({ parentItems }) => {
  const add = action(() => parentItems.push({ title: "New" }));
  return { [UI]: <ct-button onClick={add}>Add to Parent</ct-button> };
});
```

This works because passed Cells become SigilLinks with `overwrite: "redirect"` - writes
flow to the parent and the reference survives JSON serialization.

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
| Add/remove from array | `action()` |
| Complex/reusable logic | `action()` |
| Transform data | `computed()` |
| Filter/sort lists | `computed()` |
| Cross-charm mutation | `Stream.send()` |
| Make charm discoverable | Export `mentionable` |

### Writable<> in Type Signatures

| Type | Meaning |
|------|---------|
| `items: Item[]` | Read-only, reactive |
| `items: Writable<Item[]>` | Read + write (will mutate) |
| `items: Default<Item[], []>` | Optional with default |

### Writing Handlers with action()

The simplest way to write handlers is with `action()` inside the pattern body:

```typescript
export default pattern<{ count: Cell<number> }>(({ count }) => {
  // Define action inside pattern body - closures are handled automatically
  const increment = action(() => count.set(count.get() + 1));
  const addAmount = action((e: { amount: number }) => count.set(count.get() + e.amount));

  return {
    [UI]: (
      <div>
        <ct-button onClick={increment}>+1</ct-button>
        <ct-button onClick={addAmount}>Add 10</ct-button>
      </div>
    ),
    increment,  // Export for cross-charm access
  };
});
```

**Key points:**
- Define `action()` inside the pattern body, not at module scope
- Close over any pattern values you need (cells, other actions)
- Event parameter is optional - omit it for void actions
- Invoke directly in JSX: `onClick={myAction}`

Use `handler()` only when you need explicit control over state binding (rare).

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

### onClick in computed()

```typescript
// ❌ Causes ReadOnlyAddressError
const ui = computed(() => (
  <ct-button onClick={handler}>Click</ct-button>
));

// ✅ Keep buttons at top level, use disabled for conditional
<ct-button disabled={!isReady} onClick={handler}>Click</ct-button>
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
