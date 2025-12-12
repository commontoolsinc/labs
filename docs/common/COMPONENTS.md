<!-- @reviewed 2025-12-11 docs-rationalization -->

# UI Components Reference

CommonTools UI components with bidirectional binding support.

## Bidirectional Binding

Use `$` prefix for automatic two-way sync. No handler needed for simple updates.

```tsx
<ct-checkbox $checked={item.done} />    // Auto-syncs checkbox state
<ct-input $value={title} />             // Auto-syncs text input
<ct-select $value={category} items={[...]} />
```

**Native HTML inputs are one-way only.** Always use `ct-*` components for form inputs.

For when to use handlers vs binding, see [PATTERNS.md](PATTERNS.md).

---

## ct-button

```tsx
// Inline handler
<ct-button onClick={() => count.set(count.get() + 1)}>Increment</ct-button>

// handler() for complex logic
<ct-button onClick={handleClick({ count })}>Increment</ct-button>
```

---

## ct-input

```tsx
// Bidirectional binding (preferred)
<ct-input $value={title} />

// With placeholder
<ct-input $value={searchQuery} placeholder="Search..." />

// Manual handler for side effects
<ct-input value={title} onct-input={(e) => {
  title.set(e.detail.value);
  console.log("Changed:", e.detail.value);
}} />
```

---

## ct-checkbox

```tsx
// Bidirectional binding
<ct-checkbox $checked={item.done}>{item.title}</ct-checkbox>

// In array maps
{items.map((item) => (
  <ct-checkbox $checked={item.done}>{item.title}</ct-checkbox>
))}
```

---

## ct-select

Uses `items` attribute with `{ label, value }` objects. **Do not use `<option>` elements.**

```tsx
<ct-select
  $value={category}
  items={[
    { label: "Produce", value: "Produce" },
    { label: "Dairy", value: "Dairy" },
    { label: "Other", value: "Other" },
  ]}
/>

// Values can be any type
<ct-select
  $value={selectedId}
  items={[
    { label: "First", value: 1 },
    { label: "Second", value: 2 },
  ]}
/>

// Dynamic items from data
<ct-select
  $value={selectedUser}
  items={users.map(u => ({ label: u.name, value: u }))}
/>
```

---

## ct-list

Pre-styled list component. **Requires `title` property, optional `done`.**

```tsx
interface CtListItem {
  title: string;
  done?: boolean;
}

<ct-list $value={items} editable={false} />
```

**Don't use ct-list** if you have custom fields. Use manual rendering instead:

```tsx
// Custom fields require manual rendering
{items.map((item) => (
  <div>
    <ct-checkbox $checked={item.done}>{item.title}</ct-checkbox>
    <ct-input $value={item.category} />
  </div>
))}
```

---

## ct-message-input

Input + button combo for adding items.

```tsx
<ct-message-input
  buttonText="Add item"
  placeholder="New item"
  onct-send={(e) => {
    const text = e.detail?.message?.trim();
    if (text) items.push({ title: text, done: false });
  }}
/>
```

---

## ct-card

Styled card with built-in padding (1rem). Don't add extra padding to children.

```tsx
// ✅ Let ct-card handle padding
<ct-card>
  <ct-vstack gap={1}>
    <h3>Title</h3>
    <p>Content</p>
  </ct-vstack>
</ct-card>

// ❌ Double padding
<ct-card>
  <div style="padding: 1rem;">Content</div>
</ct-card>
```

---

## ct-render

Renders pattern instances for composition.

```tsx
import SubPattern from "./sub-pattern.tsx";

const subView = SubPattern({ items });

// Three equivalent ways:
<ct-render $cell={subView} />   // Most explicit
{subView}                        // Direct interpolation
<SubPattern items={items} />     // JSX syntax
```

**Use `$cell`, not `charm` or `pattern` attribute.**

Multiple patterns sharing data:

```tsx
const listView = ListView({ items });
const gridView = GridView({ items });

<div style={{ display: "flex", gap: "1rem" }}>
  <ct-render $cell={listView} />
  <ct-render $cell={gridView} />
</div>
// Both views stay in sync automatically
```

See [PATTERNS.md](PATTERNS.md) Level 4 for more on composition.

---

## ct-outliner

Tree structure editor. See `packages/patterns/page.tsx` for complete example.

```tsx
type OutlinerNode = {
  body: Default<string, "">;
  children: Default<any[], []>;
  attachments: Default<OpaqueRef<any>[], []>;
};

<ct-outliner $value={outline} />
```

---

## ct-cell-context

Debugging tool for inspecting cell values. See [CELL_CONTEXT.md](CELL_CONTEXT.md).

```tsx
<ct-cell-context $cell={result} label="Result">
  <div>{result.value}</div>
</ct-cell-context>
```

---

## Removing Array Items

Use `Cell.equals()` for identity comparison:

```tsx
const removeItem = handler<unknown, { items: Cell<Item[]>; item: OpaqueRef<Item> }>(
  (_, { items, item }) => {
    const current = items.get();
    const index = current.findIndex((el) => Cell.equals(item, el));
    if (index >= 0) items.set(current.toSpliced(index, 1));
  }
);
```

---

## Style Syntax

| Element | Syntax | Example |
|---------|--------|---------|
| HTML (`div`, `span`) | Object, camelCase | `style={{ backgroundColor: "#fff" }}` |
| Custom (`ct-*`) | String, kebab-case | `style="background-color: #fff;"` |

```tsx
// Mixed usage
<div style={{ display: "flex", gap: "1rem" }}>
  <ct-vstack style="flex: 1; padding: 1rem;">
    <span style={{ color: "#333" }}>Label</span>
  </ct-vstack>
</div>
```
