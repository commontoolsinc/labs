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
} from "commonfabric";

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
      <cf-vstack gap="3">
        {favorites!.map((item) => (
          <cf-cell-context $cell={item.cell}>
            <cf-vstack gap="2">
              <cf-hstack gap="2" align="center">
                <cf-cell-link $cell={item.cell} spaceName={item.spaceName} />
                <cf-button
                  variant="destructive"
                  size="sm"
                  onClick={onRemoveFavorite({
                    favorites: favorites!,
                    item: item.cell,
                  })}
                >
                  Remove
                </cf-button>
              </cf-hstack>
              <cf-tags
                tags={item.userTags}
                oncf-change={onUpdateUserTags({ userTags: item.userTags })}
              />
            </cf-vstack>
          </cf-cell-context>
        ))}
        {favorites!.length === 0 && <p>No favorites yet.</p>}
      </cf-vstack>
    ),
  };
});
