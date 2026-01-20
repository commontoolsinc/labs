/// <cts-enable />
/**
 * Favorites Manager pattern.
 */
import {
  Default,
  handler,
  NAME,
  pattern,
  UI,
  wish,
  Writable,
} from "commontools";

type Favorite = {
  cell: Writable<{ [NAME]?: string }>;
  tag: string;
  userTags: Writable<string[]>;
  spaceName?: string;
  spaceDid?: string;
};

const onRemoveFavorite = handler<
  Record<string, never>,
  { favorites: Writable<Default<Array<Favorite>, []>>; item: Writable<unknown> }
>((_, { favorites, item }) => {
  const favorite = favorites.get().find((f: Favorite) => f.cell.equals(item));
  if (favorite) favorites.remove(favorite);
});

const onUpdateUserTags = handler<
  { detail: { tags: string[] } },
  { userTags: Writable<string[]> }
>(({ detail }, { userTags }) => {
  userTags.set(detail?.tags ?? []);
});

export default pattern<Record<string, never>>((_) => {
  // Use wish() to access favorites from home.tsx via defaultPattern
  const { result: favorites } = wish<Default<Array<Favorite>, []>>({
    query: "#favorites",
  });

  return {
    [NAME]: "Favorites Manager",
    [UI]: (
      <ct-vstack gap="3">
        {favorites.map((item) => (
          <ct-cell-context $cell={item.cell}>
            <ct-vstack gap="2">
              <ct-hstack gap="2" align="center">
                <ct-cell-link $cell={item.cell} />
                <ct-button
                  variant="destructive"
                  size="sm"
                  onClick={onRemoveFavorite({
                    favorites,
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
        {favorites.length === 0 && <ct-text>No favorites yet.</ct-text>}
      </ct-vstack>
    ),
  };
});
