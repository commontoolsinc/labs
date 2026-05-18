export type SummaryWritable<T> = {
  get(): T;
};

export type SummarizableValue = {
  summary?: unknown;
  [key: string]: unknown;
};

export type SummaryEntry<T extends SummarizableValue> = {
  piece: SummaryWritable<T>;
  summary: string;
  name: string;
};

function extractSummary(piece: SummarizableValue): string | undefined {
  const summary = piece?.summary;
  if (!summary) return undefined;

  if (typeof summary === "object" && "get" in summary) {
    const value = (summary as { get: () => unknown }).get();
    return typeof value === "string" && value.trim() ? value : undefined;
  }

  return typeof summary === "string" && summary.trim() ? summary : undefined;
}

function isWritablePiece<T extends SummarizableValue>(
  piece: unknown,
): piece is SummaryWritable<T> {
  return !!piece && typeof (piece as { get?: unknown }).get === "function";
}

export function collectSummaryEntries<T extends SummarizableValue>(
  mentionable: unknown,
): SummaryEntry<T>[] {
  const result: SummaryEntry<T>[] = [];
  for (const piece of (Array.isArray(mentionable) ? mentionable : [])) {
    if (!isWritablePiece<T>(piece)) continue;
    const value = piece.get();
    const summary = extractSummary(value);
    if (!summary) continue;
    const name = (value.$NAME ?? "").toString();
    result.push({ piece, summary, name });
  }
  return result;
}
