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
} from "commonfabric";
import { type MentionablePiece } from "./backlinks-index.tsx";
import { collectSummaryEntries as collectSummaryEntriesImpl } from "./summary-index-entries.ts";

export type SummarizablePiece = MentionablePiece & { summary?: string };

export type SummaryIndexEntry = {
  piece: Writable<SummarizablePiece>;
  summary: string;
  name: string;
};

type Input = Record<string, never>;

type Output = {
  entries: SummaryIndexEntry[];
  search: PatternToolResult<{ entries: SummaryIndexEntry[] }>;
};

export function collectSummaryEntries(
  mentionable: unknown,
): SummaryIndexEntry[] {
  return collectSummaryEntriesImpl<SummarizablePiece>(
    mentionable,
  ) as SummaryIndexEntry[];
}

/** Search sub-pattern: filters entries by query matching summary or name. */
interface SearchInput {
  /** Substring to match against piece names and summaries. Pass an empty string to return all entries. */
  query: string;
  entries: Writable<SummaryIndexEntry>[];
}

export const searchPattern = pattern<
  SearchInput,
  Writable<SummaryIndexEntry>[]
>(({ query, entries }) => {
  return computed(() => {
    if (!query || query.trim() === "") return entries;
    const lowerQuery = query.toLowerCase().trim();
    return entries.filter(
      (entry) =>
        entry.get().summary.toLowerCase().includes(lowerQuery) ||
        entry.get().name.toLowerCase().includes(lowerQuery),
    );
  });
});

const SummaryIndex = pattern<Input, Output>(() => {
  const mentionable = wish<Writable<SummarizablePiece>[] | Default<[]>>({
    query: "#mentionable",
  }).result;

  const query = Writable.of("");

  const entries = computed(() => {
    return collectSummaryEntries(mentionable);
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
      <cf-screen>
        <cf-toolbar slot="header" sticky>
          <h2 style={{ margin: 0, fontSize: "18px" }}>Search</h2>
        </cf-toolbar>

        <cf-vstack gap="4" padding="6">
          <cf-input $value={query} placeholder="Search summaries..." />
          <span
            style={{
              fontSize: "13px",
              color: "var(--cf-color-text-secondary)",
            }}
          >
            {filteredCount} of {entryCount} pieces
          </span>

          <cf-table full-width>
            <tbody>
              {filtered.map((entry) => (
                <tr>
                  <td style={{ fontWeight: "500", whiteSpace: "nowrap" }}>
                    <cf-cell-link $cell={entry.piece} />
                  </td>
                  <td
                    style={{
                      fontSize: "13px",
                      color: "var(--cf-color-text-secondary)",
                    }}
                  >
                    {entry.summary}
                  </td>
                </tr>
              ))}
            </tbody>
          </cf-table>
        </cf-vstack>
      </cf-screen>
    ),
    entries,
    search: patternTool(searchPattern, { entries }),
  };
});

export default SummaryIndex;
