/// <cts-enable />
import {
  computed,
  type Default,
  NAME,
  pattern,
  patternTool,
  type PatternToolResult,
  UI,
  wish,
  Writable,
} from "commontools";
import { type MentionablePiece } from "./backlinks-index.tsx";

export type SummarizablePiece = MentionablePiece & { summary?: string };

export type SummaryIndexEntry = {
  piece: SummarizablePiece;
  summary: string;
  name: string;
};

type Input = Record<string, never>;

type Output = {
  entries: SummaryIndexEntry[];
  search: PatternToolResult<{ entries: SummaryIndexEntry[] }>;
};

function extractSummary(piece: any): string | undefined {
  const summary = piece?.summary;
  if (!summary) return undefined;

  if (typeof summary === "object" && "get" in summary) {
    const value = summary.get();
    return typeof value === "string" && value.trim() ? value : undefined;
  }

  return typeof summary === "string" && summary.trim() ? summary : undefined;
}

/** Search sub-pattern: filters entries by query matching summary or name. */
export const searchPattern = pattern<
  { query: string; entries: SummaryIndexEntry[] },
  SummaryIndexEntry[]
>(({ query, entries }) => {
  return computed(() => {
    if (!query || query.trim() === "") return entries;
    const lowerQuery = query.toLowerCase().trim();
    return entries.filter(
      (entry) =>
        entry.summary.toLowerCase().includes(lowerQuery) ||
        entry.name.toLowerCase().includes(lowerQuery),
    );
  });
});

const SummaryIndex = pattern<Input, Output>(() => {
  const mentionable = wish<Default<SummarizablePiece[], []>>({
    query: "#mentionable",
  }).result;

  const query = Writable.of("");

  const entries = computed(() => {
    const result: SummaryIndexEntry[] = [];
    for (const piece of mentionable ?? []) {
      if (!piece) continue;
      const summary = extractSummary(piece);
      if (!summary) continue;
      const name = (piece[NAME] ?? "").toString();
      result.push({ piece: piece as SummarizablePiece, summary, name });
    }
    return result;
  });

  const filtered = computed(() => {
    const q = query.get().toLowerCase().trim();
    if (!q) return entries;
    return entries.filter(
      (entry) =>
        entry.summary.toLowerCase().includes(q) ||
        entry.name.toLowerCase().includes(q),
    );
  });

  const entryCount = computed(() => entries.length);
  const filteredCount = computed(() => filtered.length);

  return {
    [NAME]: "SummaryIndex",
    [UI]: (
      <ct-screen>
        <ct-toolbar slot="header" sticky>
          <h2 style={{ margin: 0, fontSize: "18px" }}>Search</h2>
        </ct-toolbar>

        <ct-vstack gap="4" padding="6">
          <ct-input $value={query} placeholder="Search summaries..." />
          <span
            style={{
              fontSize: "13px",
              color: "var(--ct-color-text-secondary)",
            }}
          >
            {filteredCount} of {entryCount} pieces
          </span>

          <ct-table full-width>
            <tbody>
              {filtered.map((entry) => (
                <tr>
                  <td style={{ fontWeight: "500", whiteSpace: "nowrap" }}>
                    <ct-cell-link $cell={entry.piece} />
                  </td>
                  <td
                    style={{
                      fontSize: "13px",
                      color: "var(--ct-color-text-secondary)",
                    }}
                  >
                    {entry.summary}
                  </td>
                </tr>
              ))}
            </tbody>
          </ct-table>
        </ct-vstack>
      </ct-screen>
    ),
    entries,
    search: patternTool(searchPattern, { entries }),
  };
});

export default SummaryIndex;
