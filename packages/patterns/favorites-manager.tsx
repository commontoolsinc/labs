/// <cts-enable />
/**
 * Favorites Manager pattern.
 * Referenced in: docs/common/FAVORITES.md
 *
 * @reviewed 2025-12-10 docs-rationalization
 */
import { Cell, computed, handler, NAME, pattern, UI, wish } from "commontools";

// Updated type to support both new tagsCell and legacy tag field
type Favorite = {
  cell: Cell<{ [NAME]?: string }>;
  tagsCell?: Cell<string[]>; // New: reactive tags array
  tag?: string; // Legacy: single tag string
};

const onRemoveFavorite = handler<
  Record<string, never>,
  { favorites: Cell<Array<Favorite>>; item: Cell<unknown> }
>((_, { favorites, item }) => {
  favorites.set([
    ...favorites.get().filter((f: Favorite) => !f.cell.equals(item)),
  ]);
});

export default pattern<Record<string, never>>((_) => {
  const wishResult = wish<Array<Favorite>>({ query: "#favorites" });

  return {
    [NAME]: "Favorites Manager",
    [UI]: (
      <div>
        {wishResult.result.map((item) => {
          // Display tags from tagsCell (new) or tag (legacy)
          const tags = computed(() => {
            if (item.tagsCell) {
              const cellTags = item.tagsCell.get();
              return Array.isArray(cellTags) ? cellTags.join(", ") : "";
            }
            return item.tag ?? "";
          });

          return (
            <ct-cell-context $cell={item.cell}>
              <div>
                <ct-cell-link $cell={item.cell} />
                <ct-button
                  onClick={onRemoveFavorite({
                    favorites: wishResult.result,
                    item: item.cell,
                  })}
                >
                  Remove
                </ct-button>
                <pre>{tags}</pre>
              </div>
            </ct-cell-context>
          );
        })}
      </div>
    ),
  };
});
