import { type Cell, NAME, type Runtime } from "@commontools/runner";
import { LLMClient } from "@commontools/llm";
import {
  type Journal,
  type JournalEntry,
  type JournalEventType,
  journalSchema,
  type JournalSnapshot,
  type ObjectStub,
} from "@commontools/home-schemas";

// Re-export types for consumers
export type { Journal, JournalEntry, JournalEventType, JournalSnapshot };

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
    "piece:favorited": "favorited",
    "piece:unfavorited": "unfavorited",
    "piece:created": "created",
    "piece:modified": "modified",
    "space:entered": "entered a space",
  };

  const prompt =
    `Generate a brief journal entry (1-2 sentences) describing this user action.

Event: User ${eventDescriptions[eventType]} a piece
Piece name: ${snapshot.name || "unnamed"}
${
      snapshot.valueExcerpt
        ? `Content preview: ${snapshot.valueExcerpt.slice(0, 100)}`
        : ""
    }
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
    return `${eventDescriptions[eventType]} "${snapshot.name || "a piece"}"`;
  }
}

/**
 * Get the most recent entry's narrative for context
 */
function getPreviousNarrative(
  journal: readonly JournalEntry[],
): string | undefined {
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
    subject: subject as Cell<ObjectStub>,
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
  const normalizedTag = tag.startsWith("#")
    ? tag.toLowerCase()
    : `#${tag}`.toLowerCase();
  const journal = getHomeJournal(runtime);
  const entries = journal.get() || [];
  return entries.filter((entry: JournalEntry) =>
    entry.tags?.some((t: string) => t.toLowerCase() === normalizedTag)
  );
}
