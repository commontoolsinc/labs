/// <cts-enable />
import {
  computed,
  equals,
  generateText,
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

type JournalSnapshot = {
  name?: string;
  schemaTag?: string;
  valueExcerpt?: string;
};

type JournalEntry = {
  timestamp?: number;
  eventType?: string;
  subject?: { cell: { "/": string }; path: string[] };
  snapshot?: JournalSnapshot;
  narrative?: string;
  narrativePending?: boolean;
  tags?: string[];
  space?: string;
};

/**
 * Capture a snapshot of a cell's current state for journaling.
 * Extracts name, schema tag, and a value excerpt.
 */
function captureSnapshot(
  cell: Writable<{ [NAME]?: string }>,
  schemaTag?: string,
): JournalSnapshot {
  let name = "";
  let valueExcerpt = "";

  try {
    const value = cell.get();
    if (value && typeof value === "object" && NAME in value) {
      name = value[NAME] || "";
    }
  } catch {
    // Ignore errors - name is optional
  }

  try {
    const value = cell.get();
    if (value !== undefined) {
      const str = JSON.stringify(value);
      valueExcerpt = str.length > 200 ? str.slice(0, 200) + "..." : str;
    }
  } catch {
    // Ignore errors - excerpt is optional
  }

  return { name, schemaTag: schemaTag || "", valueExcerpt };
}

/**
 * Extract hashtags from schema tag string for searchability
 */
function extractTags(schemaTag: string): string[] {
  const tags: string[] = [];
  const hashtagMatches = schemaTag.match(/#([a-z0-9-]+)/gi);
  if (hashtagMatches) {
    tags.push(...hashtagMatches.map((t) => t.toLowerCase()));
  }
  return tags;
}

// Handler to add a favorite
const addFavorite = handler<
  { charm: Writable<{ [NAME]?: string }>; tag?: string; spaceName?: string },
  { favorites: Writable<Favorite[]>; journal: Writable<JournalEntry[]> }
>(({ charm, tag, spaceName }, { favorites, journal }) => {
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

    const schemaTag = tag || JSON.stringify(schema) || "";

    favorites.push({
      cell: charm,
      tag: schemaTag,
      userTags: [],
      spaceName,
      spaceDid,
    });

    // Add journal entry for the favorite action
    const snapshot = captureSnapshot(charm, schemaTag);
    journal.push({
      timestamp: Date.now(),
      eventType: "charm:favorited",
      subject: charm as any,
      snapshot,
      narrative: "",
      narrativePending: true,
      tags: extractTags(schemaTag),
      space: spaceName || "",
    });
  }
});

// Handler to remove a favorite
const removeFavorite = handler<
  { charm: Writable<unknown> },
  { favorites: Writable<Favorite[]>; journal: Writable<JournalEntry[]> }
>(({ charm }, { favorites, journal }) => {
  const favorite = favorites.get().find((f) => equals(f.cell, charm));
  if (favorite) {
    // Capture snapshot before removing
    const snapshot = captureSnapshot(
      charm as Writable<{ [NAME]?: string }>,
      favorite.tag,
    );

    favorites.remove(favorite);

    // Add journal entry for the unfavorite action
    journal.push({
      timestamp: Date.now(),
      eventType: "charm:unfavorited",
      subject: charm as any,
      snapshot,
      narrative: "",
      narrativePending: true,
      tags: extractTags(favorite.tag || ""),
      space: favorite.spaceName || "",
    });
  }
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

  // === REACTIVE NARRATIVE ENRICHMENT ===
  // Find the first pending entry that needs a narrative
  const pendingEntry = computed(() =>
    journal.get().find((e) => e.narrativePending && !e.narrative)
  );

  // Event type descriptions for narrative generation
  const eventDescriptions: Record<string, string> = {
    "charm:favorited": "favorited",
    "charm:unfavorited": "unfavorited",
    "charm:created": "created",
    "charm:modified": "modified",
    "space:entered": "entered a space",
  };

  // Generate narrative for pending entry
  const narrativeGen = generateText({
    prompt: computed(() => {
      const entry = pendingEntry;
      if (!entry) return ""; // No-op when nothing pending
      const eventDesc = eventDescriptions[entry.eventType || ""] ||
        entry.eventType;
      return `Generate a brief journal entry (1-2 sentences) describing this user action.

Event: User ${eventDesc} a charm
Charm name: ${entry.snapshot?.name || "unnamed"}
${
        entry.snapshot?.valueExcerpt
          ? `Content preview: ${entry.snapshot.valueExcerpt.slice(0, 100)}`
          : ""
      }

Write in past tense, personal style, like a thoughtful journal entry. Focus on the meaning and what it might indicate about the user's goals. Be concise.`;
    }),
    system:
      "You are writing brief journal entries about user activity. Be concise, observational, and connect actions to potential user intent when relevant.",
    model: "anthropic:claude-sonnet-4-5",
  });

  // Idempotent writeback - update entry when narrative is ready
  const writeNarrative = computed(() => {
    const result = narrativeGen.result;
    const pending = narrativeGen.pending;
    const entry = pendingEntry;

    // Guard: only proceed when we have a result and entry
    if (pending || !result || !entry) return null;

    // Idempotent check: already written?
    if (entry.narrative !== "") return null;

    // Find and update the entry in the array
    const entries = journal.get();
    const idx = entries.findIndex((e) => e.timestamp === entry.timestamp);
    if (idx === -1) return null;

    // Create updated entry
    const updatedEntry = {
      ...entries[idx],
      narrative: result,
      narrativePending: false,
    };

    // Replace in array and set
    const newEntries = [...entries];
    newEntries[idx] = updatedEntry;
    journal.set(newEntries);

    return result;
  });

  // Reference writeNarrative to ensure it's evaluated
  void writeNarrative;

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
    addFavorite: addFavorite({ favorites, journal }),
    removeFavorite: removeFavorite({ favorites, journal }),
    addJournalEntry: addJournalEntry({ journal }),
  };
});
