/// <cts-enable />
/**
 * Favorites Manager pattern.
 * Referenced in: docs/common/FAVORITES.md
 *
 * @reviewed 2025-12-10 docs-rationalization
 */
import { Cell, Writable, handler, NAME, pattern, UI, wish } from "commontools";

type Favorite = {
  cell: Writable<{ [NAME]?: string }>;
  tag: string;
  userTags: Writable<string[]>;
};

const onRemoveFavorite = handler<
  Record<string, never>,
  { favorites: Writable<Array<Favorite>>; item: Writable<unknown> }
>((_, { favorites, item }) => {
  favorites.set([
    ...favorites.get().filter((f: Favorite) => !f.cell.equals(item)),
  ]);
});

const onUpdateUserTags = handler<
  { detail: { tags: string[] } },
  { userTags: Writable<string[]> }
>(({ detail }, { userTags }) => {
  userTags.set(detail?.tags ?? []);
});

export default pattern<Record<string, never>>((_) => {
  const wishResult = wish<Array<Favorite>>({ query: "#favorites" });

  return {
    [NAME]: "Favorites Manager",
    [UI]: (
      <ct-vstack gap="3">
        {wishResult.result.map((item) => (
          <ct-cell-context $cell={item.cell}>
            <ct-vstack gap="2">
              <ct-hstack gap="2" align="center">
                <ct-cell-link $cell={item.cell} />
                <ct-button
                  variant="destructive"
                  size="sm"
                  onClick={onRemoveFavorite({
                    favorites: wishResult.result,
                    item: item.cell,
                  })}
                >
                  Remove
                </ct-button>
              </ct-hstack>
              <ct-tags
                tags={item.userTags}
                onct-change={onUpdateUserTags({ userTags: item.userTags })}
              />
            </ct-vstack>
          </ct-cell-context>
        ))}
      </ct-vstack>
    ),
  };
});
