/// <cts-enable />
/**
 * Example: Consumer charm for charm linking.
 * Referenced in: docs/common/CHARM_LINKING.md
 *
 * @reviewed 2025-12-10 docs-rationalization
 */
import { Default, NAME, pattern, UI, lift } from "commontools";

interface Stats {
  average: number;
  count: number;
  min: number;
  max: number;
}

/** GPA Stats Reader */
interface Input {
  name: Default<string, "gpa-reader-v1">;
  gpaStats: Default<Stats | null, null>;
}

const fmt = lift((n: number | undefined) =>
  n !== undefined ? n.toFixed(2) : "—"
);
const getAvg = lift((s: Stats | null) => s?.average);
const getMin = lift((s: Stats | null) => s?.min);
const getMax = lift((s: Stats | null) => s?.max);
const getCount = lift((s: Stats | null) => s?.count ?? 0);

export default pattern<Input, Input>(({ name, gpaStats }) => {
  return {
    [NAME]: "GPA Reader",
    [UI]: (
      <div style={{ padding: "16px", background: "#f0f8ff" }}>
        <h2>GPA Statistics (Linked)</h2>
        <table>
          <tbody>
            <tr>
              <td><strong>Count:</strong></td>
              <td>{getCount(gpaStats)}</td>
            </tr>
            <tr>
              <td><strong>Average:</strong></td>
              <td>{fmt(getAvg(gpaStats))}</td>
            </tr>
            <tr>
              <td><strong>Min:</strong></td>
              <td>{fmt(getMin(gpaStats))}</td>
            </tr>
            <tr>
              <td><strong>Max:</strong></td>
              <td>{fmt(getMax(gpaStats))}</td>
            </tr>
          </tbody>
        </table>
        <p style={{ fontSize: "12px", color: "#666", marginTop: "16px" }}>
          Data updates automatically when source changes.
        </p>
      </div>
    ),
    name,
    gpaStats,
  };
});
