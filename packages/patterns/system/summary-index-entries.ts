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

type UnexpectedMentionable = {
  index: number;
  kind: string;
  name?: string;
  keys?: string[];
  summaryKind?: string;
  hasSummary: boolean;
  hasGet: boolean;
};

export type SummaryEntryOptions = {
  logUnexpected?: boolean;
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

function describeUnexpectedMentionable(
  piece: unknown,
  index: number,
): UnexpectedMentionable {
  const isObject = !!piece && typeof piece === "object";
  const record = isObject ? piece as Record<string, unknown> : undefined;
  const summary = record?.summary;
  return {
    index,
    kind: piece === null ? "null" : typeof piece,
    name: typeof record?.$NAME === "string" ? record.$NAME : undefined,
    keys: record ? Object.keys(record).slice(0, 12) : undefined,
    summaryKind: summary === null ? "null" : typeof summary,
    hasSummary: summary !== undefined,
    hasGet: typeof (piece as { get?: unknown } | undefined)?.get === "function",
  };
}

export function collectSummaryEntries<T extends SummarizableValue>(
  mentionable: unknown,
  options: SummaryEntryOptions = {},
): SummaryEntry<T>[] {
  const result: SummaryEntry<T>[] = [];
  const unexpected: UnexpectedMentionable[] = [];
  for (
    const [index, piece] of (Array.isArray(mentionable) ? mentionable : [])
      .entries()
  ) {
    if (!isWritablePiece<T>(piece)) {
      unexpected.push(describeUnexpectedMentionable(piece, index));
      continue;
    }
    const value = piece.get();
    const summary = extractSummary(value);
    if (!summary) continue;
    const name = (value.$NAME ?? "").toString();
    result.push({ piece, summary, name });
  }
  if (options.logUnexpected && unexpected.length > 0) {
    console.warn(
      "[summary-index] expected #mentionable entries to be cell handles, got plain values",
      {
        total: Array.isArray(mentionable) ? mentionable.length : 0,
        unexpectedCount: unexpected.length,
        unexpected: unexpected.slice(0, 20),
      },
    );
  }
  return result;
}
