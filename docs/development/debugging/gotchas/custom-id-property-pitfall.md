# Custom `id` Property Pitfall

**Symptom:** Click handlers do nothing, lookups fail silently, or IDs compare as `[object Object]`.

**Cause:** Adding a custom `id` property to your data types for manual tracking, then trying to use it for lookups or comparisons.

```typescript
// PROBLEMATIC - Custom id for tracking
interface Deck {
  id: string;       // Seems reasonable...
  name: string;
  cards: Card[];
}

// In a .map() callback, deck.id is a Cell, NOT a plain string
{decks.map((deck) => (
  <ct-button onClick={() => {
    // This fails silently - deck.id is a Cell, not "deck-1"
    goToReview.send({ deckId: deck.id });
  }}>
    Review {deck.name}
  </ct-button>
))}
```

**Why this happens:** When you iterate with `.map()`, each property access on the item returns a reactive Cell wrapping the value, not the raw value itself. This is fundamental to how the reactivity system works.

## The Fix: Use `equals()` Instead of ID Lookups

```typescript
import { equals } from 'commontools';

// CORRECT - No id property needed
interface Deck {
  name: string;
  cards: Card[];
}

// Use equals() for object identity comparison
{decks.map((deck) => (
  <ct-button onClick={() => {
    const allDecks = decks.get();
    const idx = allDecks.findIndex((d) => equals(deck, d));
    if (idx >= 0) {
      selectedDeckIndex.set(idx);
      currentView.set("review");
    }
  }}>
    Review {deck.name}
  </ct-button>
))}
```

## Key Principles

1. **Don't add `id` properties for tracking** - The reactivity system handles identity
2. **Properties in `.map()` are Cells** - Not plain values you can pass directly
3. **Use `equals()` for identity** - Works with Cells or plain values
4. **Store indices when needed** - If you need to reference items, use array position

## Alternative: Use Indices Directly

```typescript
// Even simpler - use the index from map
{decks.map((deck, index) => (
  <ct-button onClick={() => {
    selectedDeckIndex.set(index);
    currentView.set("review");
  }}>
    Review {deck.name}
  </ct-button>
))}
```

## See Also

- @common/concepts/equality.md - The `equals()` function
- @common/concepts/reactivity.md - Why properties return Cells
- @development/debugging/gotchas/computed-cell-object-object.md - Related Cell-to-string coercion issue
