/// <cts-enable />
import { NAME, pattern, UI } from "commontools";
import FavoritesManager from "./favorites-manager.tsx";

export default pattern((_) => {
  const favorites = FavoritesManager({});

  return {
    [NAME]: `Home`,
    [UI]: (
      <ct-screen>
        <h1>
          home<strong>space</strong>
        </h1>

        <ct-card>
          {favorites}
        </ct-card>
      </ct-screen>
    ),
  };
});
