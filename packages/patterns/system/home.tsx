/// <cts-enable />
import {
  computed,
  equals,
  handler,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";
import FavoritesManager from "./favorites-manager.tsx";
import Journal from "./journal.tsx";

// Types from favorites-manager.tsx and journal.tsx
type Favorite = {
  cell: { [NAME]?: string };
  tag: string;
  userTags: string[];
  spaceName?: string;
  spaceDid?: string;
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
  { charm: Writable<{ [NAME]?: string }>; tag?: string; spaceName?: string },
  { favorites: Writable<Favorite[]> }
>(({ charm, tag, spaceName }, { favorites }) => {
  const current = favorites.get();
  if (!current.some((f) => equals(f.cell, charm))) {
    // HACK(seefeld): Access internal API to get schema.
    // Once we sandbox, we need proper reflection
    //
    // This first resolves all links, then clears the schema, so it's forced to
    // read the schema defined in the pattern, then reconstructs that schema.
    let schema = (charm as any)?.resolveAsCell()?.asSchema(undefined)
      .asSchemaFromLinks?.()?.schema;
    if (typeof schema !== "object") schema = ""; // schema can be true or false

    // Get spaceDid from the charm cell
    const spaceDid = (charm as any)?.space as string | undefined;

    favorites.push({
      cell: charm,
      tag: tag || JSON.stringify(schema) || "",
      userTags: [],
      spaceName,
      spaceDid,
    });
  }
});

// Handler to remove a favorite
const removeFavorite = handler<
  { charm: Writable<unknown> },
  { favorites: Writable<Favorite[]> }
>(({ charm }, { favorites }) => {
  const favorite = favorites.get().find((f) => equals(f.cell, charm));
  if (favorite) favorites.remove(favorite);
});

// Handler to add a journal entry
const addJournalEntry = handler<
  { entry: JournalEntry },
  { journal: Writable<JournalEntry[]> }
>(({ entry }, { journal }) => {
  journal.push(entry);
});

export default pattern((_) => {
  // OWN the data cells (.for for id stability)
  const favorites = Writable.of<Favorite[]>([]).for("favorites");
  const journal = Writable.of<JournalEntry[]>([]).for("journal");

  // Child components use wish() to access favorites/journal through defaultPattern
  const favoritesComponent = FavoritesManager({});
  const journalComponent = Journal({});
  const activeTab = Writable.of("journal").for("activeTab");

  // Compute unique spaces from favorites
  const uniqueSpaces = computed(() => {
    const spaceMap = new Map<
      string,
      { spaceDid: string; spaceName?: string }
    >();
    for (const fav of favorites.get()) {
      const did = fav.spaceDid;
      if (did && !spaceMap.has(did)) {
        spaceMap.set(did, { spaceDid: did, spaceName: fav.spaceName });
      }
    }
    return Array.from(spaceMap.values());
  });

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
            <ct-tab value="spaces">Spaces</ct-tab>
          </ct-tab-list>
          <ct-tab-panel value="journal">{journalComponent}</ct-tab-panel>
          <ct-tab-panel value="favorites">{favoritesComponent}</ct-tab-panel>
          <ct-tab-panel value="spaces">
            <ct-vstack gap="2">
              {uniqueSpaces.map((space) => (
                <ct-space-link
                  spaceName={space.spaceName}
                  spaceDid={space.spaceDid}
                />
              ))}
              {uniqueSpaces.length === 0 && (
                <p style="color: var(--ct-color-text-secondary); text-align: center; padding: 1rem;">
                  No spaces yet. Favorite charms from different spaces to see
                  them here.
                </p>
              )}
            </ct-vstack>
          </ct-tab-panel>
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
