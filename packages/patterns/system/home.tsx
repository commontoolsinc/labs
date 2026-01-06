/// <cts-enable />
import { NAME, pattern, UI } from "commontools";
import FavoritesManager from "./favorites-manager.tsx";
import Journal from "./journal.tsx";

export default pattern((_) => {
  const favorites = FavoritesManager({});
  const journal = Journal({});
  const activeTab = Cell.of("journal");

  return {
    [NAME]: `Home`,
    [UI]: (
      <ct-screen>
        <h1>
          home<strong>space</strong>
        </h1>

        <ct-tabs $value={activeTab}>
          <ct-tab-list>
            <ct-tab value="journal">Journal</ct-tab>
            <ct-tab value="favorites">Favorites</ct-tab>
          </ct-tab-list>
          <ct-tab-panel value="journal">{journal}</ct-tab-panel>
          <ct-tab-panel value="favorites">{favorites}</ct-tab-panel>
        </ct-tabs>
      </ct-screen>
    ),
  };
});
