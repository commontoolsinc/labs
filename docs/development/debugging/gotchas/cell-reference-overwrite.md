# Cell Reference Overwrite Pitfall

**Symptom:** Setting a Cell to "point to" another item works once, but subsequent `.set()` calls overwrite the item's data instead of changing which item is selected.

**Cause:** Storing a Cell reference directly in another Cell. When you do `selected.set(item)` where `item` is a Cell, the link chain resolution means subsequent writes to `selected` follow the chain and overwrite the *target* (the item) instead of the *reference* (which item is selected).

```typescript
// PROBLEMATIC - Direct Cell reference
interface Input {
  items: Item[];
  selected: Writable<Item>;  // Storing item directly
}

// In a click handler:
selected.set(item);  // First set works...
selected.set(otherItem);  // This may overwrite `item` instead of changing selection!
```

**Why this happens:** The reactivity system uses links between Cells. When you set a Cell to another Cell's value, you're creating a link. The next `.set()` follows that link chain to the end and writes there, not to the original Cell.

## The Fix: Box the Reference

Wrap the Cell reference in an object so the link doesn't resolve through:

```typescript
// CORRECT - Boxed reference
interface Input {
  items: Item[];
  selected: Writable<{ item: Item }>;  // Boxed in an object
}

// Setting:
selected.set({ item });

// Reading:
const { item } = selected.get();
// or
const currentItem = selected.get().item;
```

## Alternative: Use .key()

You can also use `.key()` to navigate to a nested property:

```typescript
// ALTERNATIVE - Using .key()
interface Input {
  items: Item[];
  selected: Writable<{ item: Item }>;
}

// Setting:
selected.key("item").set(item);

// Reading:
const currentItem = selected.key("item").get();
```

## Key Principles

1. **Never store Cell references directly** - Always box them in an object
2. **Link chains follow through** - `.set()` writes to the end of the chain
3. **Boxing breaks the chain** - The object wrapper prevents link resolution
4. **Use indices as alternative** - Storing an index instead of a reference also works

## When This Matters

This primarily affects "selection" patterns where you want to track which item from a list is currently active:

```typescript
// ❌ Anti-pattern
interface Input {
  items: Item[];
  currentItem: Writable<Item>;  // Will cause overwrite issues
}

// ✅ Correct patterns
interface Input {
  items: Item[];
  currentItem: Writable<{ item: Item }>;  // Boxed reference
}

// or use an index
interface Input {
  items: Item[];
  selectedIndex: Writable<number>;  // Index-based selection
}
```

## See Also

- @common/concepts/types-and-schemas/writable.md - Writable type system
- @development/debugging/gotchas/custom-id-property-pitfall.md - Related Cell behavior in `.map()`
- @common/concepts/reactivity.md - How the reactivity system works
