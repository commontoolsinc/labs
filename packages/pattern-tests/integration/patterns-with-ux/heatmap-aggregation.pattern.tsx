/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  compute,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

interface HeatmapAggregationArgs {
  width: Default<number, 4>;
  height: Default<number, 3>;
  interactions: Default<HeatmapInteractionInput[], []>;
}

interface HeatmapInteractionInput {
  x?: number;
  y?: number;
  weight?: number;
}

interface HeatmapBucket {
  x: number;
  y: number;
  weight: number;
}

interface HeatmapPeak {
  x: number;
  y: number;
  intensity: number;
}

interface RecordInteractionEvent {
  x?: number;
  y?: number;
  weight?: number;
}

interface RecordInteractionBatchEvent {
  points?: RecordInteractionEvent[];
}

type InteractionEvent = RecordInteractionEvent | RecordInteractionBatchEvent;

const sanitizeDimension = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.floor(value);
  if (rounded < 1) return fallback;
  if (rounded > 50) return 50;
  return rounded;
};

const sanitizeWeight = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  const sanitized = Math.max(0, value);
  return Math.round(sanitized * 100) / 100;
};

const clampCoordinate = (value: unknown, maxIndex: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const floored = Math.floor(value);
  if (floored < 0) return 0;
  if (floored > maxIndex) return maxIndex;
  return floored;
};

const sanitizeInteractions = (
  value: unknown,
  width: number,
  height: number,
): HeatmapBucket[] => {
  if (!Array.isArray(value)) return [];
  const maxX = width > 0 ? width - 1 : 0;
  const maxY = height > 0 ? height - 1 : 0;
  const sanitized: HeatmapBucket[] = [];
  for (const item of value) {
    const record = item as HeatmapInteractionInput | undefined;
    const x = clampCoordinate(record?.x, maxX);
    const y = clampCoordinate(record?.y, maxY);
    const weight = sanitizeWeight(record?.weight);
    sanitized.push({ x, y, weight });
  }
  return sanitized;
};

const buildGrid = (
  width: number,
  height: number,
  buckets: readonly HeatmapBucket[],
): number[][] => {
  const rows = Array.from(
    { length: height },
    () => Array.from({ length: width }, () => 0),
  );
  for (const bucket of buckets) {
    const row = rows[bucket.y] ?? rows[rows.length - 1];
    if (!row) continue;
    const current = row[bucket.x] ?? 0;
    const next = Math.round((current + bucket.weight) * 100) / 100;
    row[bucket.x] = next;
  }
  return rows;
};

const findMaxIntensity = (grid: readonly (readonly number[])[]): number => {
  let max = 0;
  for (const row of grid) {
    for (const value of row) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      if (value > max) max = value;
    }
  }
  return Math.round(max * 100) / 100;
};

const normalizeGrid = (
  grid: readonly (readonly number[])[],
  maxIntensity: number,
): number[][] => {
  if (maxIntensity <= 0) {
    return grid.map((row) => row.map(() => 0));
  }
  const factor = 1 / maxIntensity;
  return grid.map((row) =>
    row.map((value) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return 0;
      const normalized = value * factor;
      return Math.round(normalized * 100) / 100;
    })
  );
};

const locatePeaks = (
  grid: readonly (readonly number[])[],
  maxIntensity: number,
): HeatmapPeak[] => {
  if (maxIntensity <= 0) return [];
  const peaks: HeatmapPeak[] = [];
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y];
    for (let x = 0; x < row.length; x++) {
      const value = row[x];
      if (value === maxIntensity) {
        peaks.push({ x, y, intensity: value });
      }
    }
  }
  return peaks;
};

const describePeaks = (peaks: readonly HeatmapPeak[]): string => {
  if (peaks.length === 0) return "no hotspots";
  if (peaks.length === 1) {
    const [peak] = peaks;
    return `(${peak.x},${peak.y})`;
  }
  return peaks
    .map((peak) => `(${peak.x},${peak.y})`)
    .join(" • ");
};

const recordInteraction = handler(
  (
    event: InteractionEvent | undefined,
    context: {
      interactions: Cell<HeatmapInteractionInput[]>;
      width: Cell<number>;
      height: Cell<number>;
    },
  ) => {
    const width = sanitizeDimension(context.width.get(), 4);
    const height = sanitizeDimension(context.height.get(), 3);
    if (context.width.get() !== width) context.width.set(width);
    if (context.height.get() !== height) context.height.set(height);

    const current = context.interactions.get();
    const list = Array.isArray(current) ? current.slice() : [];

    const applyPoint = (point: RecordInteractionEvent | undefined) => {
      if (!point) return;
      const [bucket] = sanitizeInteractions([point], width, height);
      if (!bucket) return;
      list.push({ x: bucket.x, y: bucket.y, weight: bucket.weight });
    };

    if (
      Array.isArray((event as RecordInteractionBatchEvent | undefined)?.points)
    ) {
      for (const item of (event as RecordInteractionBatchEvent).points ?? []) {
        applyPoint(item);
      }
    } else {
      applyPoint(event as RecordInteractionEvent | undefined);
    }

    context.interactions.set(list);
  },
);

const updateDimensions = handler(
  (
    event: { width?: number; height?: number } | undefined,
    context: { width: Cell<number>; height: Cell<number> },
  ) => {
    const currentWidth = sanitizeDimension(context.width.get(), 4);
    const currentHeight = sanitizeDimension(context.height.get(), 3);
    const nextWidth = sanitizeDimension(event?.width, currentWidth);
    const nextHeight = sanitizeDimension(event?.height, currentHeight);
    if (nextWidth !== currentWidth) context.width.set(nextWidth);
    if (nextHeight !== currentHeight) context.height.set(nextHeight);
  },
);

// UI-specific handlers
const recordClick = handler(
  (
    _event: unknown,
    context: {
      interactions: Cell<HeatmapInteractionInput[]>;
      width: Cell<number>;
      height: Cell<number>;
      clickX: Cell<string>;
      clickY: Cell<string>;
      clickWeight: Cell<string>;
    },
  ) => {
    const xStr = context.clickX.get();
    const yStr = context.clickY.get();
    const weightStr = context.clickWeight.get();

    const x = parseFloat(xStr);
    const y = parseFloat(yStr);
    const weight = weightStr === "" ? 1 : parseFloat(weightStr);

    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    const width = sanitizeDimension(context.width.get(), 4);
    const height = sanitizeDimension(context.height.get(), 3);

    const current = context.interactions.get();
    const list = Array.isArray(current) ? current.slice() : [];

    const [bucket] = sanitizeInteractions([{ x, y, weight }], width, height);
    if (!bucket) return;

    list.push({ x: bucket.x, y: bucket.y, weight: bucket.weight });
    context.interactions.set(list);

    // Clear form
    context.clickX.set("");
    context.clickY.set("");
    context.clickWeight.set("");
  },
);

const clearInteractions = handler(
  (
    _event: unknown,
    context: { interactions: Cell<HeatmapInteractionInput[]> },
  ) => {
    context.interactions.set([]);
  },
);

export const heatmapAggregation = recipe<HeatmapAggregationArgs>(
  "Heatmap Aggregation",
  ({ width, height, interactions }) => {
    const sanitizedWidth = lift((value: number | undefined) =>
      sanitizeDimension(value, 4)
    )(width);
    const sanitizedHeight = lift((value: number | undefined) =>
      sanitizeDimension(value, 3)
    )(height);

    const buckets = lift(
      (
        inputs: {
          source: HeatmapInteractionInput[];
          width: number;
          height: number;
        },
      ): HeatmapBucket[] =>
        sanitizeInteractions(
          inputs.source,
          inputs.width,
          inputs.height,
        ),
    )({ source: interactions, width: sanitizedWidth, height: sanitizedHeight });

    const bucketGrid = lift(
      (
        inputs: { width: number; height: number; buckets: HeatmapBucket[] },
      ): number[][] => buildGrid(inputs.width, inputs.height, inputs.buckets),
    )({ buckets, width: sanitizedWidth, height: sanitizedHeight });

    const maxIntensity = lift(findMaxIntensity)(bucketGrid);

    const normalizedGrid = lift(
      (inputs: { grid: number[][]; max: number }) =>
        normalizeGrid(inputs.grid, inputs.max),
    )({ grid: bucketGrid, max: maxIntensity });

    const peaks = lift(
      (inputs: { grid: number[][]; max: number }) =>
        locatePeaks(inputs.grid, inputs.max),
    )({ grid: bucketGrid, max: maxIntensity });

    const interactionCount = lift((items: HeatmapBucket[]) => {
      const total = items.reduce((sum, item) => sum + item.weight, 0);
      return Math.round(total * 100) / 100;
    })(buckets);

    const peakSummary = lift(describePeaks)(peaks);

    const label = str`Peak intensity ${maxIntensity} at ${peakSummary}`;

    // UI state
    const clickX = cell("");
    const clickY = cell("");
    const clickWeight = cell("");

    const name = str`Heatmap ${sanitizedWidth}×${sanitizedHeight}`;

    const heatmapCells = lift(
      (
        inputs: {
          grid: number[][];
          normalized: number[][];
          max: number;
          width: number;
          height: number;
        },
      ) => {
        const elements = [];
        const grid = inputs.grid;
        const normalized = inputs.normalized;
        const max = inputs.max;

        for (let y = 0; y < inputs.height; y++) {
          for (let x = 0; x < inputs.width; x++) {
            const rawValue = grid[y]?.[x] ?? 0;
            const normValue = normalized[y]?.[x] ?? 0;

            const intensity = max > 0 ? normValue : 0;
            const hue = 200;
            const saturation = 80;
            const lightness = 95 - Math.round(intensity * 70);
            const bgColor = "hsl(" + String(hue) + ", " + String(saturation) +
              "%, " + String(lightness) + "%)";
            const borderColor = intensity > 0.8 ? "#0066cc" : "rgba(0,0,0,0.1)";
            const borderWidth = intensity > 0.8 ? "2px" : "1px";

            const cellStyle = "display: flex; flex-direction: column; " +
              "align-items: center; justify-content: center; " +
              "padding: 12px; border: " + borderWidth + " solid " +
              borderColor + "; " +
              "border-radius: 8px; background: " + bgColor + "; " +
              "min-width: 80px; min-height: 80px; " +
              "transition: all 0.2s ease;";

            const coordStyle = "font-size: 11px; color: #666; " +
              "font-family: monospace; margin-bottom: 4px;";

            const rawStyle = "font-size: 18px; font-weight: 600; " +
              "color: #222; font-family: monospace;";

            const normStyle = "font-size: 12px; color: #888; " +
              "font-family: monospace; margin-top: 2px;";

            elements.push(
              <div key={String(y) + "-" + String(x)} style={cellStyle}>
                <div style={coordStyle}>{String(x) + "," + String(y)}</div>
                <div style={rawStyle}>{String(rawValue)}</div>
                <div style={normStyle}>
                  {normValue.toFixed(2)}
                </div>
              </div>,
            );
          }
        }

        return elements;
      },
    )({
      grid: bucketGrid,
      normalized: normalizedGrid,
      max: maxIntensity,
      width: sanitizedWidth,
      height: sanitizedHeight,
    });

    const ui = (
      <ct-card style="padding: 24px; max-width: 1200px; margin: 0 auto;">
        <h1 style="margin: 0 0 8px 0; font-size: 28px; font-weight: 700; color: #111;">
          Heatmap Aggregation
        </h1>
        <p style="margin: 0 0 24px 0; color: #666; font-size: 14px;">
          Visualize interaction intensity across a grid with peak detection
        </p>

        <div style="display: flex; gap: 24px; margin-bottom: 24px;">
          <ct-card style="flex: 1; padding: 16px; background: #f8f9fa;">
            <h3 style="margin: 0 0 12px 0; font-size: 14px; font-weight: 600; color: #555;">
              Grid Configuration
            </h3>
            <div style="display: flex; flex-direction: column; gap: 12px;">
              <div>
                <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">
                  Width: {sanitizedWidth}
                </label>
              </div>
              <div>
                <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">
                  Height: {sanitizedHeight}
                </label>
              </div>
            </div>
          </ct-card>

          <ct-card style="flex: 1; padding: 16px; background: #f0f9ff;">
            <h3 style="margin: 0 0 12px 0; font-size: 14px; font-weight: 600; color: #555;">
              Statistics
            </h3>
            <div style="display: flex; flex-direction: column; gap: 8px;">
              <div style="display: flex; justify-content: space-between;">
                <span style="font-size: 12px; color: #666;">
                  Total Interactions:
                </span>
                <span style="font-size: 14px; font-weight: 600; color: #0066cc; font-family: monospace;">
                  {interactionCount}
                </span>
              </div>
              <div style="display: flex; justify-content: space-between;">
                <span style="font-size: 12px; color: #666;">
                  Peak Intensity:
                </span>
                <span style="font-size: 14px; font-weight: 600; color: #0066cc; font-family: monospace;">
                  {maxIntensity}
                </span>
              </div>
              <div style="display: flex; justify-content: space-between;">
                <span style="font-size: 12px; color: #666;">
                  Hotspots:
                </span>
                <span style="font-size: 14px; font-weight: 600; color: #0066cc; font-family: monospace;">
                  {peakSummary}
                </span>
              </div>
            </div>
          </ct-card>
        </div>

        <ct-card style="padding: 16px; margin-bottom: 24px; background: #fff9e6;">
          <h3 style="margin: 0 0 12px 0; font-size: 14px; font-weight: 600; color: #555;">
            Add Interaction
          </h3>
          <div style="display: flex; gap: 12px; align-items: end;">
            <div style="flex: 1;">
              <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">
                X Coordinate
              </label>
              <ct-input
                $value={clickX}
                placeholder="0"
                type="number"
                style="width: 100%;"
              />
            </div>
            <div style="flex: 1;">
              <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">
                Y Coordinate
              </label>
              <ct-input
                $value={clickY}
                placeholder="0"
                type="number"
                style="width: 100%;"
              />
            </div>
            <div style="flex: 1;">
              <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">
                Weight (default: 1)
              </label>
              <ct-input
                $value={clickWeight}
                placeholder="1"
                type="number"
                style="width: 100%;"
              />
            </div>
            <ct-button
              onClick={recordClick({
                interactions,
                width,
                height,
                clickX,
                clickY,
                clickWeight,
              })}
              style="background: #0066cc; color: white; padding: 8px 20px;"
            >
              Add Point
            </ct-button>
            <ct-button
              onClick={clearInteractions({ interactions })}
              style="background: #dc3545; color: white; padding: 8px 16px;"
            >
              Clear All
            </ct-button>
          </div>
        </ct-card>

        <ct-card style="padding: 16px; background: white;">
          <h3 style="margin: 0 0 16px 0; font-size: 14px; font-weight: 600; color: #555;">
            Intensity Heatmap
          </h3>
          <div
            style={lift(
              (w: number) =>
                "display: grid; grid-template-columns: repeat(" + String(w) +
                ", 1fr); gap: 8px;",
            )(sanitizedWidth)}
          >
            {heatmapCells}
          </div>
          <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid #e0e0e0;">
            <div style="font-size: 12px; color: #666;">
              <strong>Legend:</strong>{" "}
              Each cell shows (x,y) coordinates, raw weight, and normalized
              intensity (0-1). Darker blue = higher intensity. Cells with peak
              intensity have blue borders.
            </div>
          </div>
        </ct-card>
      </ct-card>
    );

    return {
      width,
      height,
      interactions,
      sanitizedWidth,
      sanitizedHeight,
      buckets,
      bucketGrid,
      normalizedGrid,
      maxIntensity,
      peaks,
      interactionCount,
      peakSummary,
      label,
      record: recordInteraction({ interactions, width, height }),
      resize: updateDimensions({ width, height }),
      [NAME]: name,
      [UI]: ui,
    };
  },
);
