/// <cts-enable />
/**
 * Journal viewer pattern.
 * Displays a rolling narrative stream of journal entries.
 *
 * Access via: wish({ query: "#journal" })
 */
import {
  computed,
  handler,
  NAME,
  pattern,
  UI,
  wish,
  Writable,
} from "commontools";

// Raw journal entry as stored - subject is a cell link, not a Cell
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

function formatTimestamp(timestamp: number | undefined): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

function eventTypeLabel(eventType: string | undefined): string {
  if (!eventType) return "Unknown";
  const labels: Record<string, string> = {
    "charm:favorited": "Favorited",
    "charm:unfavorited": "Unfavorited",
    "charm:created": "Created",
    "charm:modified": "Modified",
    "space:entered": "Entered space",
  };
  return labels[eventType] || eventType;
}

function eventTypeEmoji(eventType: string | undefined): string {
  if (!eventType) return "\u2022";
  const emojis: Record<string, string> = {
    "charm:favorited": "\u2b50",
    "charm:unfavorited": "\u2606",
    "charm:created": "\u2795",
    "charm:modified": "\u270f\ufe0f",
    "space:entered": "\u27a1\ufe0f",
  };
  return emojis[eventType] || "\u2022";
}

const clearJournal = handler<
  Record<string, never>,
  { journal: Writable<JournalEntry[]> }
>((_, { journal }) => {
  journal.set([]);
});

export default pattern<Record<string, never>>((_) => {
  // Use wish() to access journal from home.tsx via defaultPattern
  const journalResult = wish<Array<JournalEntry>>({
    query: "#journal",
  });

  // Debug: log raw result
  const debugRaw = computed(() => {
    const raw = journalResult.result;
    console.log("[journal.tsx] raw journalResult.result:", raw);
    console.log("[journal.tsx] type:", typeof raw);
    if (Array.isArray(raw)) {
      console.log("[journal.tsx] first entry:", raw[0]);
    }
    return JSON.stringify(raw, null, 2);
  });

  // Most recent entries first
  const entries = computed(() => {
    const journal = journalResult.result || [];
    return [...journal].reverse();
  });

  const entryCount = computed(() => entries.length);

  return {
    [NAME]: "Journal",
    [UI]: (
      <div style={{ padding: "16px", maxWidth: "800px", margin: "0 auto" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "24px",
          }}
        >
          <h2 style={{ margin: "0" }}>Activity Journal</h2>
          {entryCount > 0 && (
            <ct-button
              onClick={clearJournal({ journal: journalResult.result })}
              variant="secondary"
            >
              Clear Journal
            </ct-button>
          )}
        </div>

        {/* Debug section */}
        <details style={{ marginBottom: "16px", fontSize: "12px" }}>
          <summary>Debug: Raw Data</summary>
          <pre
            style={{
              overflow: "auto",
              maxHeight: "200px",
              background: "#f5f5f5",
              padding: "8px",
            }}
          >
            {debugRaw}
          </pre>
        </details>

        {entryCount === 0 && (
          <div
            style={{
              textAlign: "center",
              padding: "40px",
              color: "#666",
            }}
          >
            <p>No journal entries yet.</p>
            <p style={{ fontSize: "0.9em" }}>
              Favorite some pieces to start building your journal.
            </p>
          </div>
        )}

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "16px",
          }}
        >
          {entries.map((entry) => (
            <div
              style={{
                border: "1px solid #e0e0e0",
                borderRadius: "8px",
                padding: "16px",
                backgroundColor: "#fff",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  marginBottom: "8px",
                }}
              >
                <span style={{ fontSize: "1.2em" }}>
                  {eventTypeEmoji(entry.eventType)}
                </span>
                <span
                  style={{
                    fontWeight: "500",
                    color: "#1976d2",
                  }}
                >
                  {eventTypeLabel(entry.eventType)}
                </span>
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: "0.85em",
                    color: "#666",
                  }}
                >
                  {formatTimestamp(entry.timestamp)}
                </span>
              </div>

              {entry.narrative && (
                <p
                  style={{
                    margin: "8px 0",
                    lineHeight: "1.5",
                    color: "#333",
                  }}
                >
                  {entry.narrative}
                </p>
              )}

              {entry.snapshot?.name && (
                <div
                  style={{
                    marginTop: "8px",
                    fontSize: "0.9em",
                    color: "#555",
                  }}
                >
                  {entry.snapshot.name}:{" "}
                  {entry.subject && <ct-cell-link $cell={entry.subject} />}
                </div>
              )}

              {entry.tags && entry.tags.length > 0 && (
                <div
                  style={{
                    marginTop: "8px",
                    display: "flex",
                    gap: "4px",
                    flexWrap: "wrap",
                  }}
                >
                  {entry.tags.map((tag: string) => (
                    <span
                      style={{
                        fontSize: "0.8em",
                        padding: "2px 8px",
                        borderRadius: "12px",
                        backgroundColor: "#e3f2fd",
                        color: "#1565c0",
                      }}
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    ),
  };
});
