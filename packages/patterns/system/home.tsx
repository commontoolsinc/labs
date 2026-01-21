/// <cts-enable />
import {
  computed,
  equals,
  generateObject,
  generateText,
  handler,
  NAME,
  pattern,
  toSchema,
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

// === PROFILE TYPES ===
type Fact = {
  content: string;
  confidence: number;
  source: string;
  timestamp: number;
};

type Preference = {
  key: string;
  value: string;
  confidence: number;
  source: string;
};

type Question = {
  id: string;
  question: string;
  category: string;
  priority: number;
  options?: string[];
  status: "pending" | "asked" | "answered" | "skipped";
  answer?: string;
};

type LearnedSection = {
  facts: Fact[];
  preferences: Preference[];
  openQuestions: Question[];
  personas: string[];
  lastJournalProcessed: number;
};

type ProfileExtraction = {
  facts: Array<{ content: string; confidence: number }>;
  preferences: Array<{ key: string; value: string; confidence: number }>;
  personas: string[];
  questions: Array<{
    question: string;
    category: string;
    priority: number;
    options?: string[];
  }>;
};

const EMPTY_LEARNED: LearnedSection = {
  facts: [],
  preferences: [],
  openQuestions: [],
  personas: [],
  lastJournalProcessed: 0,
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
  const learned = Writable.of<LearnedSection>(EMPTY_LEARNED).for("learned");

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

  // === PROFILE LEARNING ===
  // Find journal entries with narratives that haven't been processed for profile
  const unprocessedEntries = computed(() => {
    const entries = journal.get();
    const lastProcessed = learned.get().lastJournalProcessed || 0;
    return entries.filter(
      (e) => (e.timestamp || 0) > lastProcessed && e.narrative,
    );
  });

  // Generate profile insights from unprocessed journal entries
  const profileExtraction = generateObject<ProfileExtraction>({
    prompt: computed(() => {
      const entries = unprocessedEntries;
      if (!entries || entries.length === 0) return "";

      const currentLearned = learned.get();
      const currentFacts = currentLearned.facts;
      const currentPrefs = currentLearned.preferences;

      return `Analyze these recent user actions and extract profile insights.

Recent actions:
${
        entries.map((e) =>
          `- ${e.eventType}: ${e.narrative || e.snapshot?.name || "unknown"}`
        ).join("\n")
      }

Current known facts: ${currentFacts.map((f) => f.content).join(", ") || "none"}
Current preferences: ${
        currentPrefs.map((p) => `${p.key}=${p.value}`).join(", ") || "none"
      }

Extract:
1. facts - clear statements about the user (e.g., "interested in cooking", "has children")
2. preferences - key-value pairs about user preferences
3. personas - short descriptive labels (e.g., "busy parent", "tech enthusiast")
4. questions - clarifying questions to ask the user (if needed)

Be conservative - only extract facts you're confident about (confidence 0.5-1.0).
Avoid duplicating existing facts. Return empty arrays if nothing new to learn.`;
    }),
    system: `You extract user profile information from their activity.
Be conservative - only add facts with clear evidence.
Return valid JSON matching the schema.`,
    schema: toSchema<ProfileExtraction>(),
    model: "anthropic:claude-haiku-4-5",
  });

  // Idempotent writeback - apply extracted insights to learned section
  const applyExtraction = computed(() => {
    const result = profileExtraction.result;
    const pending = profileExtraction.pending;
    const entries = unprocessedEntries;

    // Guard: only proceed when we have results and entries to process
    if (pending || !result || !entries || entries.length === 0) return null;

    // Get current state
    const currentLearned = learned.get();
    const lastProcessed = currentLearned.lastJournalProcessed || 0;

    // Find the max timestamp from processed entries
    const maxTimestamp = Math.max(...entries.map((e) => e.timestamp || 0));

    // Idempotent check: already processed these entries?
    if (maxTimestamp <= lastProcessed) return null;

    // Build updated learned section
    let updatedLearned = { ...currentLearned };

    // Apply new facts (with deduplication)
    if (result.facts && result.facts.length > 0) {
      const existingContents = new Set(
        currentLearned.facts.map((f) => f.content),
      );
      const newFacts = result.facts
        .filter((f) => !existingContents.has(f.content))
        .map((f) => ({
          content: f.content,
          confidence: f.confidence,
          source: `journal:${maxTimestamp}`,
          timestamp: Date.now(),
        }));
      if (newFacts.length > 0) {
        updatedLearned = {
          ...updatedLearned,
          facts: [...currentLearned.facts, ...newFacts],
        };
      }
    }

    // Apply new preferences
    if (result.preferences && result.preferences.length > 0) {
      const existingKeys = new Set(
        currentLearned.preferences.map((p) => p.key),
      );
      const newPrefs = result.preferences
        .filter((p) => !existingKeys.has(p.key))
        .map((p) => ({
          key: p.key,
          value: p.value,
          confidence: p.confidence,
          source: `journal:${maxTimestamp}`,
        }));
      if (newPrefs.length > 0) {
        updatedLearned = {
          ...updatedLearned,
          preferences: [...currentLearned.preferences, ...newPrefs],
        };
      }
    }

    // Apply new personas
    if (result.personas && result.personas.length > 0) {
      const existingPersonas = new Set(currentLearned.personas);
      const newPersonas = result.personas.filter((p) =>
        !existingPersonas.has(p)
      );
      if (newPersonas.length > 0) {
        updatedLearned = {
          ...updatedLearned,
          personas: [...currentLearned.personas, ...newPersonas],
        };
      }
    }

    // Apply new questions
    if (result.questions && result.questions.length > 0) {
      const existingQuestionTexts = new Set(
        currentLearned.openQuestions.map((q) => q.question),
      );
      const newQuestions = result.questions
        .filter((q) => !existingQuestionTexts.has(q.question))
        .map((q) => ({
          id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          question: q.question,
          category: q.category,
          priority: q.priority,
          options: q.options,
          status: "pending" as const,
        }));
      if (newQuestions.length > 0) {
        updatedLearned = {
          ...updatedLearned,
          openQuestions: [...currentLearned.openQuestions, ...newQuestions],
        };
      }
    }

    // Update last processed timestamp
    updatedLearned = {
      ...updatedLearned,
      lastJournalProcessed: maxTimestamp,
    };

    // Write the updated learned section
    learned.set(updatedLearned);

    return result;
  });

  // Reference applyExtraction to ensure it's evaluated
  void applyExtraction;

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
    learned,

    // Exported handlers (bound to state cells for external callers)
    addFavorite: addFavorite({ favorites, journal }),
    removeFavorite: removeFavorite({ favorites, journal }),
    addJournalEntry: addJournalEntry({ journal }),
  };
});
