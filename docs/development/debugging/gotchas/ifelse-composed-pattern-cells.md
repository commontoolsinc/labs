# ifElse with Composed Pattern Cells

**Symptom:** Piece never renders, no errors, blank UI

```typescript
// WRONG - May hang - cell from composed pattern
const showDetails = subPattern.isExpanded;
{ifElse(showDetails, <div>Details</div>, null)}

// CORRECT - Use local computed cell
const showDetails = computed(() => subPattern.isExpanded);
{ifElse(showDetails, <div>Details</div>, null)}
```

**Why:** When using cells from composed patterns directly with `ifElse()`, the reactivity chain may not be properly established. Wrapping in a local `computed()` ensures proper reactive context.

## See Also

- @common/concepts/reactivity.md - Reactivity system and computed()
