# View Switching

Any cell result with `[UI]` renders when placed in JSX — you don't need to know what pattern produced it. This is the foundation of all view switching: change which cell is in the vdom, and the UI updates.

## Approach 1: Switch on a String

Use a `Writable<string>` to represent the active view. A `computed()` block maps the string to a pattern instance:

```tsx
import { computed, handler, pattern, UI, Writable } from "commontools";
import EditView from "./edit-view.tsx";
import PreviewView from "./preview-view.tsx";
import SettingsView from "./settings-view.tsx";

export default pattern<{ activeView: Writable<string> }>(({ activeView }) => {
  const view = computed(() => {
    switch (activeView.get()) {
      case "edit":     return EditView({});
      case "preview":  return PreviewView({});
      case "settings": return SettingsView({});
      default:         return null;
    }
  });

  const setView = handler<unknown, { id: string; activeView: Writable<string> }>(
    (_, { id, activeView }) => activeView.set(id)
  );

  return {
    [UI]: (
      <div>
        <div>
          <ct-button onClick={setView({ id: "edit", activeView })}>Edit</ct-button>
          <ct-button onClick={setView({ id: "preview", activeView })}>Preview</ct-button>
          <ct-button onClick={setView({ id: "settings", activeView })}>Settings</ct-button>
        </div>
        <>{view}</>
      </div>
    ),
  };
});
```

When `activeView` changes, the `computed` re-runs and returns a different sub-pattern. The runtime extracts its `[UI]` and renders it in place.

**Real example:** `packages/patterns/catalog/ui/story-renderer.tsx` — the UI component catalog uses this pattern with 25+ views.

## Approach 2: Update a Cell Pointer

Instead of mapping a string to a view, hold a direct reference to the active cell and update it:

```tsx
import { computed, equals, handler, pattern, UI, Writable } from "commontools";

interface Item { title: string; description: string }

export default pattern<{
  items: Writable<Item[]>;
  activeItem: Writable<Item | null>;
}>(({ items, activeItem }) => {
  const selectItem = handler<unknown, {
    activeItem: Writable<Item | null>;
    items: Writable<Item[]>;
    index: number;
  }>((_, { activeItem, items, index }) => {
    activeItem.set(items.get()[index]);
  });

  const itemsWithSelection = computed(() => {
    const selected = activeItem.get();
    return items.get().map((item, index) => ({
      item, index,
      isSelected: selected !== null && equals(selected, item),
    }));
  });

  return {
    [UI]: (
      <div>
        {itemsWithSelection.map((entry) => (
          <div
            onClick={selectItem({ activeItem, items, index: entry.index })}
            style={{ fontWeight: entry.isSelected ? "bold" : "normal" }}
          >
            {entry.item.title}
          </div>
        ))}
        <div>{activeItem}</div>
      </div>
    ),
    activeItem,
  };
});
```

This is useful when:
- Selecting from a dynamic list (you don't know the items at compile time)
- Rendering anonymous cells — you just need to display whatever the pointer references
- Embedding cells from other patterns or spaces

**Rendering anonymous cells:** Use `<ct-render $cell={piece} />` to render any cell's `[UI]`, even if you don't know its type. See `packages/patterns/system/piece-grid.tsx` for an example rendering a grid of arbitrary pieces.

## Approach 3: Tabs

For simple tabbed UIs, `ct-tabs` handles string-based view switching as a built-in:

```tsx
const activeTab = Writable.of("spaces").for("activeTab");

<ct-tabs $value={activeTab}>
  <ct-tab-list>
    <ct-tab value="spaces">Spaces</ct-tab>
    <ct-tab value="favorites">Favorites</ct-tab>
  </ct-tab-list>
  <ct-tab-panel value="spaces">{spacesView}</ct-tab-panel>
  <ct-tab-panel value="favorites">{favoritesView}</ct-tab-panel>
</ct-tabs>
```

The `.for("activeTab")` call makes the tab state durable (persisted by key). See `packages/patterns/system/home.tsx`.

## When to Use Which

| Scenario | Approach |
|---|---|
| Known set of views, menu/sidebar navigation | Switch on a string |
| Selecting from dynamic data (list items, search results) | Cell pointer |
| Simple tabbed layout with static panels | `ct-tabs` |
| Rendering cells you don't control (grids, embeds) | Cell pointer + `ct-render` |

## See Also

- [Pattern Composition](./composition.md) — embedding sub-patterns in the vdom
- [Navigation](./navigation.md) — `navigateTo()` for drill-down to detail views
- [Conditional Rendering](./conditional.md) — `ifElse` for show/hide
