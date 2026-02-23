/// <cts-enable />
import { computed, NAME, pattern, UI, wish, Writable } from "commontools";
import { type SummaryIndexEntry } from "../system/summary-index.tsx";

type SummaryIndexResult = {
  entries: SummaryIndexEntry[];
  search: { pattern: unknown; extraParams: { entries: SummaryIndexEntry[] } };
};

export default pattern<Record<string, never>>((_) => {
  const query = Writable.of("");

  const { entries } = wish<SummaryIndexResult>({
    query: "#summaryIndex",
  }).result;

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
    [NAME]: "Summary Index Tester",
    [UI]: (
      <ct-screen>
        <ct-toolbar slot="header" sticky>
          <h2 style={{ margin: 0, fontSize: "18px" }}>Summary Index Tester</h2>
        </ct-toolbar>

        <ct-vstack gap="6" padding="6">
          <ct-vstack gap="2">
            <strong>
              Index: {entryCount} entries
            </strong>
            <ct-input
              $value={query}
              placeholder="Search summaries..."
            />
            <span
              style={{
                fontSize: "13px",
                color: "var(--ct-color-text-secondary)",
              }}
            >
              Showing {filteredCount} results
            </span>
          </ct-vstack>

          <ct-table full-width>
            <thead>
              <tr>
                <th>Name</th>
                <th>Summary</th>
              </tr>
            </thead>
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
  };
});
