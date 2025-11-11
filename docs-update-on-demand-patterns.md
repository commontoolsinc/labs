# Documentation Updates: On-Demand Pattern Creation

Based on real-world pattern development experience, these additions would help developers avoid common pitfalls.

## 1. Add to PATTERNS.md - Level 4: Pattern Composition

### New Section: "When to Create Patterns On-Demand"

**Location**: After the existing Level 4 pattern composition example (around line 356)

**Content**:

```markdown
### Pattern Composition: Upfront vs On-Demand Creation

When composing patterns that share cell references, you have two approaches:

#### ✅ Upfront Creation (All patterns rendered together)

```typescript
export default recipe("Multi-View", ({ items }) => {
  // Create all patterns upfront
  const listView = ShoppingList({ items });
  const gridView = GridView({ items });

  return {
    [NAME]: "Multi-View",
    [UI]: (
      <div>
        {/* Both patterns always rendered */}
        <div>{listView}</div>
        <div>{gridView}</div>
      </div>
    ),
    items,
  };
});
```

**Use when**: All child patterns are displayed simultaneously or conditionally rendered with `ifElse()`.

#### ✅ On-Demand Creation (Patterns created when needed)

```typescript
const selectView = handler<
  unknown,
  { currentView: Cell<any>; items: any; viewType: string }
>((_event, { currentView, items, viewType }) => {
  // Create pattern on-demand in handler
  const view = viewType === "list"
    ? ShoppingList({ items })
    : GridView({ items });

  currentView.set(view);
});

export default recipe("View Selector", ({ items }) => {
  const currentView = cell<any>(null);

  return {
    [NAME]: "View Selector",
    [UI]: (
      <div>
        <ct-button onClick={selectView({ currentView, items, viewType: "list" })}>
          List View
        </ct-button>
        <ct-button onClick={selectView({ currentView, items, viewType: "grid" })}>
          Grid View
        </ct-button>

        {ifElse(
          derive(currentView, (v) => v !== null),
          <div>{currentView}</div>,
          <div />
        )}
      </div>
    ),
    items,
  };
});
```

**Use when**: Child patterns are created based on user selection or other runtime conditions.

#### Why This Matters

Creating patterns that share parent cells during recipe initialization can cause cell tracking issues when those patterns are conditionally instantiated. The framework's cell system tracks references during pattern creation - creating patterns on-demand in handlers ensures proper reference tracking.

**Common Error**: If you see "Shadow ref alias with parent cell not found in current frame", you're likely creating shared-cell child patterns during recipe init when they should be created on-demand.

**Rule of thumb**:
- Multiple views always visible → Create upfront
- User selects which view → Create on-demand in handler
```

## 2. Add to RECIPES.md - Common Pitfalls Section

**Location**: Near the existing pitfalls section (around line 450)

**Content**:

```markdown
### Pitfall: "Shadow ref alias" Error with Pattern Composition

**Error**: `Shadow ref alias with parent cell not found in current frame`

**Cause**: Creating child patterns that share parent cell references during recipe initialization, when those patterns should be created conditionally.

**Wrong**:
```typescript
export default recipe("Launcher", ({ items }) => {
  const currentView = cell("none");

  // ❌ Creating patterns upfront when they'll be conditionally used
  const listView = ShoppingList({ items });
  const gridView = GridView({ items });

  // Later: conditionally show based on user selection...
});
```

**Right**:
```typescript
const selectList = handler((_event, { items, currentView }) => {
  // ✅ Create pattern on-demand
  const view = ShoppingList({ items });
  currentView.set(view);
});

export default recipe("Launcher", ({ items }) => {
  const currentView = cell(null);

  return {
    [UI]: (
      <ct-button onClick={selectList({ items, currentView })}>
        Show List
      </ct-button>
    ),
  };
});
```

**When this applies**: Only when child patterns share cell references with parent AND are created conditionally based on user interaction.
```

## 3. Add Example to packages/patterns/

**New file**: `packages/patterns/on-demand-pattern-creation.tsx`

```typescript
/// <cts-enable />
import { cell, Cell, Default, derive, handler, ifElse, NAME, recipe, UI } from "commontools";

interface Item {
  title: string;
  done: Default<boolean, false>;
}

// Simple list view
const ListView = recipe<{ items: Default<Item[], []> }>(
  "List View",
  ({ items }) => ({
    [NAME]: "List View",
    [UI]: (
      <div>
        {items.map((item) => (
          <div>• {item.title}</div>
        ))}
      </div>
    ),
    items,
  })
);

// Grid view
const GridView = recipe<{ items: Default<Item[], []> }>(
  "Grid View",
  ({ items }) => ({
    [NAME]: "Grid View",
    [UI]: (
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
        {items.map((item) => (
          <div style={{ border: "1px solid gray", padding: "8px" }}>
            {item.title}
          </div>
        ))}
      </div>
    ),
    items,
  })
);

// Handler that creates patterns on-demand
const selectView = handler<
  unknown,
  { currentView: Cell<any>; items: any; viewType: string }
>((_event, { currentView, items, viewType }) => {
  const view = viewType === "list"
    ? ListView({ items })
    : GridView({ items });

  currentView.set(view);
});

export default recipe<{ items: Default<Item[], []> }>(
  "On-Demand Pattern Example",
  ({ items }) => {
    const currentView = cell<any>(null);
    const hasView = derive(currentView, (v) => v !== null);

    return {
      [NAME]: "View Selector",
      [UI]: (
        <div style={{ padding: "1rem" }}>
          <h3>Select a View</h3>

          <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
            <ct-button onClick={selectView({ currentView, items, viewType: "list" })}>
              List View
            </ct-button>
            <ct-button onClick={selectView({ currentView, items, viewType: "grid" })}>
              Grid View
            </ct-button>
          </div>

          {ifElse(
            hasView,
            <div>{currentView}</div>,
            <div style={{ color: "#666" }}>Choose a view above</div>
          )}
        </div>
      ),
      items,
    };
  }
);
```

## 4. Update packages/patterns/INDEX.md

Add entry for the new example:

```markdown
- **on-demand-pattern-creation.tsx**: Demonstrates creating child patterns on-demand in handlers when they share parent cell references. Shows the difference between upfront and conditional pattern creation. (Keywords: composition, handlers, conditional, dynamic)
```

## Summary

These documentation updates would:

1. **Explain the pattern**: When and why to create patterns in handlers vs recipe init
2. **Document the error**: Help developers recognize and fix "Shadow ref alias" errors
3. **Provide examples**: Show working code for both approaches
4. **Establish guidelines**: Clear rules for when to use each approach

The core insight: **Dynamic pattern creation is fully supported - use handlers for conditional/on-demand creation of patterns that share parent cells.**
