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
  // Stable key the favorite entity is addressed by (the piece's identity),
  // stored on the entry by home's addFavorite so the remove reaches it.
  id?: string;
};

const onRemoveFavorite = handler<
  Record<string, never>,
  {
    favorites: Writable<Array<Favorite> | Default<[]>>;
    id?: string;
    item?: Writable<unknown>;
  }
>((_, { favorites, id, item }) => {
  // A favorite added through the keyed path carries an id. Drop its membership
  // by that id — the same key home's addFavorite used, so both reach the same
  // entity — and clear the entity, since it outlives its link.
  if (id) {
    favorites.removeByValue(favorites.elementById(id));
    const entry: Writable<Favorite | undefined> = favorites.elementById(id);
    entry.set(undefined);
    return;
  }
  // A favorite added before keyed addressing has no id; remove it by matching
  // its piece cell.
  if (!item) return;
  favorites.set(favorites.get().filter((f) => !f.cell.equals(item)));
});

const onUpdateUserTags = handler<
  { detail: { tags: string[] } },
  { userTags: Writable<string[]> }
>(({ detail }, { userTags }) => {
  userTags.set(detail?.tags ?? []);
});

export default pattern<Record<string, never>>((_) => {
  // Use wish() to access favorites from home.tsx via defaultPattern
  const { result: favorites } = wish<Array<Favorite> | Default<[]>>({
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
                    id: item.id,
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
