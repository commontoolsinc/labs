/// <cts-enable />
import {
  computed,
  lift,
  NAME,
  pattern,
  patternTool,
  type PatternToolResult,
  UI,
} from "commontools";
import { type MentionablePiece } from "./backlinks-index.tsx";

export type SummaryIndexEntry = {
  piece: MentionablePiece;
  summary: string;
  name: string;
};

type Input = {
  mentionable: MentionablePiece[];
};

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

const buildIndex = lift<
  { mentionable: MentionablePiece[] },
  SummaryIndexEntry[]
>(({ mentionable }) => {
  const entries: SummaryIndexEntry[] = [];

  for (const piece of mentionable ?? []) {
    if (!piece) continue;

    const summary = extractSummary(piece);
    if (!summary) continue;

    const name = (piece[NAME] ?? "").toString();

    entries.push({ piece, summary, name });
  }

  return entries;
});

const searchPattern = pattern<
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

const SummaryIndex = pattern<Input, Output>(({ mentionable }) => {
  const entries = buildIndex({ mentionable });

  return {
    [NAME]: "SummaryIndex",
    [UI]: undefined,
    entries,
    search: patternTool(searchPattern, { entries }),
  };
});

export default SummaryIndex;
