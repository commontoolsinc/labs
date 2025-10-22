# Cell Integration Patterns

This document covers patterns for integrating Common Tools runtime Cell abstractions with Lit components.

## What are Cells?

Cells are reactive data containers from the Common Tools runtime (`@commontools/runner`). They provide:
- Reactive updates via subscriptions
- Transactional mutations
- Path-based access to nested data
- Runtime integration for charm execution

## When to Use Cell Integration

Use Cell integration when:
- The component needs to render reactive data from the runtime
- The component allows users to edit data that should sync back to the runtime
- The component is part of a pattern/recipe UI that manipulates charm state

Do NOT use Cell integration for:
- Simple presentational components
- Components that work with plain JavaScript values
- Layout components

## Basic Cell Patterns

### Property Declaration

Declare Cell properties using `@property({ attribute: false })`:

```typescript
import { property } from "lit/decorators.js";
import type { Cell } from "@commontools/runner";

export class MyComponent extends BaseElement {
  @property({ attribute: false })
  declare cell: Cell<MyDataType>;
}
```

Note: `attribute: false` prevents Lit from trying to serialize Cells as attributes.

### Subscribing to Cell Changes

Subscribe to cell changes in `updated()` lifecycle:

```typescript
private _unsubscribe: (() => void) | null = null;

override updated(changedProperties: Map<string, any>) {
  super.updated(changedProperties);

  if (changedProperties.has("cell")) {
    // Clean up previous subscription
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }

    // Subscribe to new Cell if it exists
    if (this.cell && isCell(this.cell)) {
      this._unsubscribe = this.cell.sink(() => {
        this.requestUpdate();
      });
    }
  }
}

override disconnectedCallback() {
  super.disconnectedCallback();
  // Clean up subscription
  if (this._unsubscribe) {
    this._unsubscribe();
    this._unsubscribe = null;
  }
}
```

### Reading Cell Values

Use `.get()` to read cell values in `render()`:

```typescript
override render() {
  if (!this.cell) {
    return html`<div>No data</div>`;
  }

  const value = this.cell.get();

  return html`<div>${value}</div>`;
}
```

### Accessing Nested Properties

Use `.key()` for nested access:

```typescript
const userCell: Cell<{ name: string; email: string }>;

// Access nested properties
const nameCell = userCell.key("name");
const name = nameCell.get(); // Get the actual value
```

### Array Cells

For array cells, use `.key(index)`:

```typescript
const listCell: Cell<string[]>;
const items = listCell.get();

// Render each item using its cell
return html`
  ${items.map((_, index) => {
    const itemCell = listCell.key(index);
    return this.renderItem(itemCell);
  })}
`;
```

## Mutating Cells

### Simple Mutations with Transactions

Always use transactions for mutations:

```typescript
function mutateCell<T>(cell: Cell<T>, mutator: (cell: Cell<T>) => void): void {
  const tx = cell.runtime.edit();
  mutator(cell.withTx(tx));
  tx.commit();
}

// Usage
mutateCell(myCell, (cell) => {
  cell.set(newValue);
});
```

### Array Mutations

```typescript
// Add item
mutateCell(listCell, (cell) => {
  cell.push({ title: "New Item", [ID]: crypto.randomUUID() });
});

// Remove item by filter
mutateCell(listCell, (cell) => {
  const filtered = cell.get().filter((_, i) => !cell.key(i).equals(itemToRemove));
  cell.set(filtered);
});

// Update item property
mutateCell(listCell, (cell) => {
  cell.key(index).key("title").set(newTitle);
});
```

### Finding Cells in Arrays

Use cell equality checking to find items:

```typescript
function findCellIndex<T>(listCell: Cell<T[]>, itemCell: Cell<T>): number {
  const length = listCell.get().length;
  for (let i = 0; i < length; i++) {
    if (itemCell.equals(listCell.key(i))) {
      return i;
    }
  }
  return -1;
}
```

## Advanced Patterns

### Supporting Both Cell and Plain Values

```typescript
@property({ attribute: false })
value: Cell<T[]> | T[] | null = null;

override render() {
  if (!this.value) {
    return html`<div>No data</div>`;
  }

  const items = isCell(this.value) ? this.value.get() : this.value;

  return html`
    ${items.map((item, index) => this.renderItem(item, index))}
  `;
}
```

### Rendering UI from Cells

The `ct-render` component handles rendering cells with `[UI]` properties:

```typescript
import { UI } from "@commontools/api";

// In render()
return html`<ct-render .cell=${myCharmCell}></ct-render>`;
```

The component automatically:
- Extracts UI subcells
- Loads recipes if needed
- Handles cleanup

### Cell Type Checking

```typescript
import { isCell } from "@commontools/runner";

if (isCell(this.value)) {
  // It's a Cell, use .get(), .key(), etc.
} else {
  // It's a plain value
}
```

## Common Pitfalls

### ❌ Don't: Forget to clean up subscriptions

```typescript
// BAD - memory leak
this.cell.sink(() => this.requestUpdate());
```

### ✅ Do: Clean up in disconnectedCallback

```typescript
// GOOD
this._unsubscribe = this.cell.sink(() => this.requestUpdate());

override disconnectedCallback() {
  super.disconnectedCallback();
  if (this._unsubscribe) {
    this._unsubscribe();
  }
}
```

### ❌ Don't: Mutate cells directly

```typescript
// BAD - no transaction
this.cell.set(newValue);
```

### ✅ Do: Use transactions

```typescript
// GOOD
mutateCell(this.cell, (cell) => cell.set(newValue));
```

### ❌ Don't: Use array index as key in repeat()

```typescript
// BAD - breaks reactivity
repeat(items, (_, index) => index, ...)
```

### ✅ Do: Use stable identifiers or composite keys

```typescript
// GOOD
repeat(items, (item, index) => `${index}-${item.title}`, ...)
```

## Real-World Example: ct-list

See `packages/ui/src/v2/components/ct-list/ct-list.ts` for a complete example demonstrating:
- Cell subscription management
- Array cell manipulation
- Finding items by cell equality
- Transaction-based mutations
- Supporting both Cell and plain array values
