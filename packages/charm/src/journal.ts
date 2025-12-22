import {
  type Cell,
  type JSONSchema,
  NAME,
  type Runtime,
  type Schema,
} from "@commontools/runner";
import { LLMClient } from "@commontools/llm";

/**
 * Journal entry event types - the significant events we track
 */
export const journalEventTypes = [
  "charm:favorited",
  "charm:unfavorited",
  "charm:created",
  "charm:modified",
  "space:entered",
] as const;

export type JournalEventType = typeof journalEventTypes[number];

/**
 * Snapshot of a cell's state at a point in time
 */
export const journalSnapshotSchema = {
  type: "object",
  properties: {
    name: { type: "string", default: "" },
    schemaTag: { type: "string", default: "" },
    valueExcerpt: { type: "string", default: "" },
  },
} as const satisfies JSONSchema;

export type JournalSnapshot = Schema<typeof journalSnapshotSchema>;

/**
 * A single journal entry capturing a significant event
 */
export const journalEntrySchema = {
  type: "object",
  properties: {
    timestamp: { type: "number" },
    eventType: {
      type: "string",
      enum: journalEventTypes as unknown as string[],
    },
    // Live cell reference (may update over time)
    subject: { not: true, asCell: true },
    // Frozen snapshot at entry time
    snapshot: journalSnapshotSchema,
    // LLM-generated narrative prose
    narrative: { type: "string", default: "" },
    // Tags for filtering/searching
    tags: {
      type: "array",
      items: { type: "string" },
      default: [],
    },
    // Space where event occurred
    space: { type: "string" },
  },
  required: ["timestamp", "eventType", "space"],
} as const satisfies JSONSchema;

export type JournalEntry = Schema<typeof journalEntrySchema>;

/**
 * The journal is an array of entries
 */
export const journalSchema = {
  type: "array",
  items: journalEntrySchema,
  default: [],
} as const satisfies JSONSchema;

export type Journal = Schema<typeof journalSchema>;

/**
 * Get the journal cell from the home space (singleton across all spaces).
 * Analogous to getHomeFavorites().
 */
export function getHomeJournal(runtime: Runtime): Cell<Journal> {
  return runtime.getHomeSpaceCell().key("journal").asSchema(journalSchema);
}

/**
 * Capture a snapshot of a cell's current state for journaling.
 * Extracts name, schema tag, and a value excerpt.
 */
export function captureSnapshot(cell: Cell<unknown>): JournalSnapshot {
  let name = "";
  let schemaTag = "";
  let valueExcerpt = "";

  try {
    // Try to get the NAME from the cell
    const nameCell = cell.key(NAME);
    const nameValue = nameCell?.get();
    if (typeof nameValue === "string") {
      name = nameValue;
    }
  } catch {
    // Ignore errors - name is optional
  }

  try {
    // Get schema as tag (similar to favorites.ts getCellDescription)
    const { schema } = cell.asSchemaFromLinks().getAsNormalizedFullLink();
    if (schema !== undefined) {
      schemaTag = JSON.stringify(schema);
    }
  } catch {
    // Ignore errors - schema is optional
  }

  try {
    // Get a short excerpt of the value
    const value = cell.get();
    if (value !== undefined) {
      const str = JSON.stringify(value);
      valueExcerpt = str.length > 200 ? str.slice(0, 200) + "..." : str;
    }
  } catch {
    // Ignore errors - excerpt is optional
  }

  return { name, schemaTag, valueExcerpt };
}

/**
 * Extract hashtags from schema tag string for searchability
 */
function extractTags(schemaTag: string): string[] {
  const tags: string[] = [];
  // Extract hashtags from schema (e.g., "#person", "#recipe")
  const hashtagMatches = schemaTag.match(/#([a-z0-9-]+)/gi);
  if (hashtagMatches) {
    tags.push(...hashtagMatches.map((t) => t.toLowerCase()));
  }
  return tags;
}

/**
 * Generate a narrative prose description for a journal entry.
 * Uses LLM to create a human-readable sentence about what happened.
 */
async function generateNarrative(
  eventType: JournalEventType,
  snapshot: JournalSnapshot,
  previousNarrative?: string,
): Promise<string> {
  const client = new LLMClient();

  const eventDescriptions: Record<JournalEventType, string> = {
    "charm:favorited": "favorited",
    "charm:unfavorited": "unfavorited",
    "charm:created": "created",
    "charm:modified": "modified",
    "space:entered": "entered a space",
  };

  const prompt = `Generate a brief journal entry (1-2 sentences) describing this user action.

Event: User ${eventDescriptions[eventType]} a charm
Charm name: ${snapshot.name || "unnamed"}
${snapshot.valueExcerpt ? `Content preview: ${snapshot.valueExcerpt.slice(0, 100)}` : ""}
${previousNarrative ? `\nPrevious context: ${previousNarrative}` : ""}

Write in past tense, personal style, like a thoughtful journal entry. Focus on the meaning and what it might indicate about the user's goals. Be concise.`;

  try {
    const response = await client.sendRequest({
      model: "anthropic:claude-haiku-4-5",
      system:
        "You are writing brief journal entries about user activity. Be concise, observational, and connect actions to potential user intent when relevant.",
      messages: [{ role: "user", content: prompt }],
      cache: true,
    });

    if (typeof response.content === "string") {
      return response.content.trim();
    }
    if (Array.isArray(response.content)) {
      const textPart = response.content.find((p) =>
        typeof p === "object" && "type" in p && p.type === "text"
      );
      if (textPart && typeof textPart === "object" && "text" in textPart) {
        return (textPart.text as string).trim();
      }
    }
    return "";
  } catch (error) {
    console.error("Failed to generate journal narrative:", error);
    // Fallback to a simple description
    return `${eventDescriptions[eventType]} "${snapshot.name || "a charm"}"`;
  }
}

/**
 * Get the most recent entry's narrative for context
 */
function getPreviousNarrative(journal: readonly JournalEntry[]): string | undefined {
  if (journal.length === 0) return undefined;
  const lastEntry = journal[journal.length - 1];
  return lastEntry?.narrative;
}

/**
 * Add a journal entry for a significant event.
 *
 * @param runtime - The runtime instance
 * @param eventType - The type of event that occurred
 * @param subject - The cell that the event relates to
 * @param space - The space where the event occurred
 */
export async function addJournalEntry(
  runtime: Runtime,
  eventType: JournalEventType,
  subject: Cell<unknown>,
  space: string,
): Promise<void> {
  const journal = getHomeJournal(runtime);
  await journal.sync();

  // Capture snapshot before any transaction
  const snapshot = captureSnapshot(subject);

  // Extract tags from schema
  const tags = extractTags(snapshot.schemaTag || "");

  // Get previous narrative for context
  const currentJournal = journal.get() || [];
  const previousNarrative = getPreviousNarrative(currentJournal);

  // Generate narrative (async, before transaction)
  const narrative = await generateNarrative(
    eventType,
    snapshot,
    previousNarrative,
  );

  const entry: JournalEntry = {
    timestamp: Date.now(),
    eventType,
    subject,
    snapshot,
    narrative,
    tags,
    space,
  };

  await runtime.editWithRetry((tx) => {
    const journalWithTx = journal.withTx(tx);
    journalWithTx.push(entry);
  });

  await runtime.idle();
}

/**
 * Get recent journal entries (most recent first)
 *
 * @param runtime - The runtime instance
 * @param limit - Maximum number of entries to return
 */
export function getRecentEntries(
  runtime: Runtime,
  limit = 10,
): JournalEntry[] {
  const journal = getHomeJournal(runtime);
  const entries = journal.get() || [];
  return entries.slice(-limit).reverse();
}

/**
 * Search journal entries by tag
 *
 * @param runtime - The runtime instance
 * @param tag - Tag to search for (with or without #)
 */
export function searchJournalByTag(
  runtime: Runtime,
  tag: string,
): JournalEntry[] {
  const normalizedTag = tag.startsWith("#") ? tag.toLowerCase() : `#${tag}`.toLowerCase();
  const journal = getHomeJournal(runtime);
  const entries = journal.get() || [];
  return entries.filter((entry: JournalEntry) =>
    entry.tags?.some((t: string) => t.toLowerCase() === normalizedTag)
  );
}
