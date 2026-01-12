/// <cts-enable />
import { handler, NAME, pattern, UI, Writable } from "commontools";
import FavoritesManager from "./favorites-manager.tsx";
import Journal from "./journal.tsx";

// Types from favorites-manager.tsx and journal.tsx
type Favorite = {
  cell: Writable<{ [NAME]?: string }>;
  tag: string;
  userTags: Writable<string[]>;
};

type JournalEntry = {
  timestamp?: number;
  eventType?: string;
  subject?: { cell: { "/": string }; path: string[] };
  snapshot?: {
    name?: string;
    schemaTag?: string;
    valueExcerpt?: string;
  };
  narrative?: string;
  tags?: string[];
  space?: string;
};

// Handler to add a favorite
const addFavorite = handler<
  { charm: Writable<{ [NAME]?: string }>; tag?: string },
  { favorites: Writable<Favorite[]> }
>(({ charm, tag }, { favorites }) => {
  const current = favorites.get();
  const resolvedCharm = charm;
  if (!current.some((f) => f.cell.equals(resolvedCharm))) {
    favorites.set([
      ...current,
      { cell: charm, tag: tag || "", userTags: Writable.of([]) },
    ]);
  }
});

// Handler to remove a favorite
const removeFavorite = handler<
  { charm: Writable<unknown> },
  { favorites: Writable<Favorite[]> }
>(({ charm }, { favorites }) => {
  favorites.set([
    ...favorites.get().filter((f: Favorite) => !f.cell.equals(charm)),
  ]);
});

// Handler to add a journal entry
const addJournalEntry = handler<
  { entry: JournalEntry },
  { journal: Writable<JournalEntry[]> }
>(({ entry }, { journal }) => {
  journal.set([...journal.get(), entry]);
});

export default pattern((_) => {
  // OWN the data cells
  const favorites = Writable.of<Favorite[]>([]);
  const journal = Writable.of<JournalEntry[]>([]);

  // Child components use wish() to access favorites/journal through defaultPattern
  const favoritesComponent = FavoritesManager({});
  const journalComponent = Journal({});
  const activeTab = Writable.of("journal");

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
          <ct-tab-panel value="journal">{journalComponent}</ct-tab-panel>
          <ct-tab-panel value="favorites">{favoritesComponent}</ct-tab-panel>
        </ct-tabs>
      </ct-screen>
    ),

    // Exported data
    favorites,
    journal,

    // Exported handlers (bound to state cells for external callers)
    addFavorite: addFavorite({ favorites }),
    removeFavorite: removeFavorite({ favorites }),
    addJournalEntry: addJournalEntry({ journal }),
  };
});
