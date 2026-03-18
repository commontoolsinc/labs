/// <cts-enable />
import {
  computed,
  type Default,
  NAME,
  pattern,
  UI,
  type VNode,
  wish,
  Writable,
} from "commontools";

export type SuggestionHistoryEntry = {
  result: Writable<any>;
  messages: any[];
  timestamp: string;
};

type Input = Record<string, never>;
type Output = { [UI]: VNode };

export const searchPattern = pattern<
  { query: string; entries: SuggestionHistoryEntry[] },
  SuggestionHistoryEntry[]
>(({ query, entries }) => {
  return computed(() => {
    if (!query || query.trim() === "") return entries;
    const q = query.toLowerCase().trim();
    return entries.filter(
      (entry: SuggestionHistoryEntry) =>
        (entry.messages ?? [])
          .find((m: any) => m.role === "user")
          ?.content?.toString()
          ?.toLowerCase()
          ?.includes(q) || (entry.timestamp ?? "").includes(q),
    );
  });
});

const SuggestionHistory = pattern<Input, Output>(() => {
  const { result: entries } = wish<Default<SuggestionHistoryEntry[], []>>({
    query: "#suggestions",
  });

  return {
    [NAME]: "Suggestion History",
    [UI]: (
      <ct-screen>
        <ct-grid columns="3" gap="4" padding="4">
          {entries.map((entry: SuggestionHistoryEntry) => (
            <div
              style={{
                border: "1px solid var(--ct-color-border, #e5e5e7)",
                borderRadius: "12px",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: "100%",
                  height: "200px",
                  overflow: "hidden",
                  position: "relative",
                }}
              >
                <div
                  style={{
                    transform: "scale(0.4)",
                    transformOrigin: "top left",
                    width: "250%",
                    height: "250%",
                    pointerEvents: "none",
                  }}
                >
                  <ct-render $cell={entry.result} />
                </div>
              </div>
              <div style={{ padding: "8px" }}>
                <ct-cell-link $cell={entry.result} />
                <div
                  style={{
                    fontSize: "12px",
                    color: "var(--ct-color-text-secondary)",
                  }}
                >
                  {entry.timestamp}
                </div>
              </div>
            </div>
          ))}
        </ct-grid>
      </ct-screen>
    ),
  };
});

export default SuggestionHistory;
