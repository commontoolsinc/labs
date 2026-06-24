# Summary Convention

Patterns should export a `summary` field — a short text string that describes
the pattern's current content. This enables space-wide search via the summary
index and makes the pattern visible to the knowledge graph.

## Basic Summary

For leaf patterns (individual items), the summary is typically the main content:

```tsx
// Shown at module scope.
export default pattern<Input, Output>(({ title, content }) => {
  return {
    [NAME]: title,
    summary: computed(() => content.slice(0, 200)),
    [UI]: <div>{content}</div>,
  };
});
```

## Hierarchical Summary (Container Patterns)

Container patterns — those that hold collections of child items — should derive
their summary from their children. This creates a **pyramid-like index
structure** where searching a container's summary also surfaces matches from its
children.

```
┌─────────────────────────────┐
│ Notebook summary:           │
│ "Meeting notes | Project    │  ← Container summary = aggregation
│  plan | Design decisions"   │     of child summaries
├─────────────────────────────┤
│ ┌──────┐ ┌──────┐ ┌──────┐ │
│ │Note 1│ │Note 2│ │Note 3│ │  ← Child summaries
│ │"Meet…"│ │"Proj…"│ │"Desi…"│ │
│ └──────┘ └──────┘ └──────┘ │
└─────────────────────────────┘
```

### Pattern

```tsx
// Shown for illustration only.
// Container with child pieces that have their own summaries
const summary = computed(() => {
  const children = items.get() ?? [];
  return children
    .map((child) => child?.summary ?? child?.[NAME] ?? "")
    .filter((s: string) => s.length > 0)
    .join(" | ");
});
```

### When children are simple data (not sub-patterns)

```tsx
// Shown inside a pattern body.
// Container with plain data items (no sub-pattern summaries)
const summary = computed(() => {
  return items.get()
    .map((item) => `${item.done ? "✓" : "○"} ${item.title}`)
    .join(", ");
});
```

### For large collections

Limit the summary to avoid excessive length:

```tsx
// Shown inside a pattern body.
const summary = computed(() => {
  return items.get()
    .slice(0, 20)
    .map((item) => item?.summary ?? "")
    .filter((s: string) => s.length > 0)
    .join(" | ");
});
```

## How It Works

The summary index pattern (`system/summary-index.tsx`) collects `summary` fields
from all mentionable pieces in the space. The knowledge graph agent and omnibox
search use these summaries to find relevant content. Without a `summary` field,
a container pattern is invisible to text-based search — even if its children
have rich content.

By deriving the container's summary from its children, a search for "quarterly
report" will match a notebook that contains a note about quarterly reports, even
though the notebook itself might just be named "Work Notes".

## Conventions

- Always use `computed()` so the summary updates reactively
- Use `" | "` as separator for child summaries (readable, distinct)
- Use `", "` as separator for simple item lists
- Truncate or limit for large collections (20 items is a reasonable cap)
- Fall back to `[NAME]` when a child doesn't have a summary
- Add `summary: string` to your pattern's Output interface
