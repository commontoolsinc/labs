/// <cts-enable />
/**
 * Example: Source charm for charm linking.
 * Referenced in: docs/common/CHARM_LINKING.md
 *
 * @reviewed 2025-12-10 docs-rationalization
 */
import { Cell, Writable, Default, handler, lift, NAME, pattern, UI } from "commontools";

interface Stats {
  average: number;
  count: number;
  min: number;
  max: number;
}

/** GPA Stats Source */
interface Input {
  name: Default<string, "gpa-source-v1">;
  rawData: Default<string, "">;
}

interface Output {
  name: string;
  rawData: string;
  gpaStats: Stats | null;
}

const parseGpas = lift((raw: string): number[] => {
  if (!raw.trim()) return [];
  return raw.split("\n")
    .map((line) => parseFloat(line.trim()))
    .filter((n) => !isNaN(n));
});

const calculateStats = lift((values: number[]): Stats | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    average: sum / sorted.length,
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
});

const updateData = handler<
  { target: { value: string } },
  { rawData: Writable<string> }
>((event, { rawData }) => {
  rawData.set(event.target.value);
});

export default pattern<Input, Output>(({ name, rawData }) => {
  const gpas = parseGpas(rawData);
  const gpaStats = calculateStats(gpas);

  return {
    [NAME]: "GPA Source",
    [UI]: (
      <div style={{ padding: "16px" }}>
        <h2>GPA Data Entry</h2>
        <textarea
          value={rawData}
          onChange={updateData({ rawData })}
          placeholder="Enter GPAs, one per line..."
          rows={8}
          style={{ width: "100%", fontFamily: "monospace" }}
        />
      </div>
    ),
    name,
    rawData,
    gpaStats,
  };
});
