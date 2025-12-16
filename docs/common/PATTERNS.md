<!-- @reviewed 2025-12-11 docs-rationalization -->

# Common Patterns

Patterns for building CommonTools applications, organized by complexity.

## Core Principles

### 1. Use computed() for Data Transformations

Cell references in pattern bodies are "opaque refs" - placeholders that can't be read directly. Wrap transformations in `computed()`:

```typescript
// ❌ WRONG
const grouped = {};
for (const entry of entries) {  // Error: "Tried to directly access an opaque value"
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

### 2. Only Declare Cell<> When You Need to Mutate

Everything is reactive by default. `Cell<>` in type signatures indicates you'll call `.set()`, `.push()`, or `.update()`:

```typescript
interface Input {
  count: number;         // Read-only (still reactive!)
  items: Cell<Item[]>;   // Will mutate (call .push(), .set())
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
import { Cell, Default, NAME, pattern, UI } from "commontools";

interface Item {
  title: string;
  done: Default<boolean, false>;
}

interface Input {
  items: Cell<Item[]>;
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
- **Uses `Cell.equals()` for item identity - no `[ID]` needed for basic list operations**
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
  items: Cell<Item[]>;
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

### Cell<> in Type Signatures

| Type | Meaning |
|------|---------|
| `items: Item[]` | Read-only, reactive |
| `items: Cell<Item[]>` | Read + write (will mutate) |
| `items: Default<Item[], []>` | Optional with default |

---

## Common Mistakes

### Direct Data Access

```typescript
// ❌ Error: "Tried to directly access an opaque value"
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
// ❌ Won't update reactively
{items.filter(i => !i.done).map(...)}

// ✅ Use computed()
const active = computed(() => items.filter(i => !i.done));
{active.map(...)}
```

### Template String Access

```typescript
// ❌ Error: "Accessing an opaque ref via closure"
const prompt = `Seed: ${seed}`;

// ✅ Wrap in computed()
const prompt = computed(() => `Seed: ${seed}`);
```

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

- [CELLS_AND_REACTIVITY.md](CELLS_AND_REACTIVITY.md) - Deep dive on reactivity
- [COMPONENTS.md](COMPONENTS.md) - UI component reference
- [TYPES_AND_SCHEMAS.md](TYPES_AND_SCHEMAS.md) - Type system details
- [DEBUGGING.md](DEBUGGING.md) - Troubleshooting guide
