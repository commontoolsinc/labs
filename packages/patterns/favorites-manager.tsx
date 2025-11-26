/// <cts-enable />
import { Cell, handler, NAME, pattern, UI, wish } from "commontools";

type Favorite = { cell: Cell<{ [NAME]?: string }>; description: string };

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
        {wishResult.result.map((item) => (
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
            <pre>{item.description}</pre>
          </div>
        ))}
      </div>
    ),
  };
});
