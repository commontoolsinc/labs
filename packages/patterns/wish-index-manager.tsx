/// <cts-enable />
import { Cell, derive, handler, NAME, pattern, UI, wish } from "commontools";

type WishIndexEntry = {
  query: string;
  resultCell: Cell<{ [NAME]?: string }>;
  patternUrl?: string;
  timestamp: number;
};

const onRemoveEntry = handler<
  Record<string, never>,
  { wishIndex: Cell<Array<WishIndexEntry>>; entry: WishIndexEntry }
>((_, { wishIndex, entry }) => {
  wishIndex.set([
    ...wishIndex.get().filter(
      (e: WishIndexEntry) =>
        e.query !== entry.query || e.timestamp !== entry.timestamp,
    ),
  ]);
});

const onClearAll = handler<
  Record<string, never>,
  { wishIndex: Cell<Array<WishIndexEntry>> }
>((_, { wishIndex }) => {
  wishIndex.set([]);
});

function formatAge(timestamp: number): string {
  const ageMs = Date.now() - timestamp;
  const ageSeconds = Math.floor(ageMs / 1000);
  const ageMinutes = Math.floor(ageSeconds / 60);
  const ageHours = Math.floor(ageMinutes / 60);
  const ageDays = Math.floor(ageHours / 24);

  if (ageDays > 0) return `${ageDays}d ago`;
  if (ageHours > 0) return `${ageHours}h ago`;
  if (ageMinutes > 0) return `${ageMinutes}m ago`;
  return "just now";
}

export default pattern<Record<string, never>>((_) => {
  const wishIndex = wish<Array<WishIndexEntry>>({ query: "#wishIndex" });

  return {
    [NAME]: "Wish Index Manager",
    [UI]: (
      <div>
        <h2>Wish Index</h2>
        <p>Cached wish resolutions (max 100, 7-day staleness)</p>

        <ct-button onClick={onClearAll({ wishIndex: wishIndex.result })}>
          Clear All
        </ct-button>

        <div style="margin-top: 16px;">
          {derive(wishIndex.result, (entries) =>
            entries.length === 0
              ? <p style="color: gray;">No cached wishes</p>
              : null
          )}

          {wishIndex.result.map((entry) => (
            <div
              style="border: 1px solid #ccc; padding: 12px; margin: 8px 0; border-radius: 4px;"
            >
              <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                <div style="flex: 1;">
                  <strong>Query:</strong> {entry.query}
                </div>
                <div style="color: gray; font-size: 0.9em;">
                  {derive(entry.timestamp, (ts) => formatAge(ts))}
                </div>
              </div>

              <div style="margin-top: 8px;">
                <strong>Result:</strong>{" "}
                <ct-cell-link $cell={entry.resultCell} />
              </div>

              {derive(entry.patternUrl, (url) =>
                url
                  ? (
                    <div style="margin-top: 4px; color: gray; font-size: 0.9em;">
                      <strong>Pattern:</strong> {url}
                    </div>
                  )
                  : null
              )}

              <div style="margin-top: 8px;">
                <ct-button
                  onClick={onRemoveEntry({
                    wishIndex: wishIndex.result,
                    entry,
                  })}
                >
                  Remove
                </ct-button>
              </div>
            </div>
          ))}
        </div>
      </div>
    ),
  };
});
