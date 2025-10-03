/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

type SortDirection = "asc" | "desc";

interface SortDirectionToggleArgs {
  count: Default<number, 0>;
  entries: Default<number[], []>;
  direction: Default<SortDirection, "asc">;
}

const formatNumber = (value: number) => {
  const finite = Number.isFinite(value) ? value : 0;
  const rounded = Math.round(finite * 100) / 100;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(2);
};

const directionText = (value: SortDirection) =>
  value === "desc" ? "descending" : "ascending";

const recordValue = handler(
  (
    event: { amount?: number } | undefined,
    context: { count: Cell<number>; entries: Cell<number[]> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const current = context.count.get();
    const base = typeof current === "number" ? current : 0;
    const next = base + amount;
    context.count.set(next);

    const existing = context.entries.get();
    const list = Array.isArray(existing) ? existing : [];
    context.entries.set([...list, next]);
  },
);

const toggleSortDirection = handler(
  (
    event: { direction?: SortDirection } | undefined,
    context: {
      direction: Cell<SortDirection>;
      history: Cell<SortDirection[]>;
    },
  ) => {
    const current = context.direction.get();
    const currentDirection = current === "desc" ? "desc" : "asc";
    const requested = event?.direction;
    const next = requested === "desc"
      ? "desc"
      : requested === "asc"
      ? "asc"
      : currentDirection === "asc"
      ? "desc"
      : "asc";

    if (next !== currentDirection) {
      context.direction.set(next);
    }

    const previous = context.history.get();
    const history = Array.isArray(previous) ? previous : [];
    context.history.set([...history, next]);
  },
);

const parseAmount = (raw: string) => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 1;
  const limited = Math.max(Math.min(parsed, 9999), -9999);
  return Math.round(limited * 100) / 100;
};

const mapEntries = (values: number[], prefix: string) =>
  values.length === 0
    ? [
      <span style="
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0.25rem 0.5rem;
          border-radius: 999px;
          background: #e2e8f0;
          color: #475569;
          font-size: 0.75rem;
        ">
        No values yet
      </span>,
    ]
    : values.map((value, index) => (
      <span
        data-testid={`${prefix}-${index}`}
        style="
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0.25rem 0.5rem;
          border-radius: 999px;
          background: #e0f2fe;
          color: #0369a1;
          font-size: 0.75rem;
          font-weight: 500;
        "
      >
        {formatNumber(value)}
      </span>
    ));

const mapHistory = (history: SortDirection[]) =>
  history.length === 0
    ? [
      <span style="
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0.25rem 0.5rem;
          border-radius: 999px;
          background: #f1f5f9;
          color: #64748b;
          font-size: 0.75rem;
        ">
        No toggles recorded
      </span>,
    ]
    : history.map((entry, index) => (
      <span
        data-testid={`direction-history-${index}`}
        style="
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0.25rem 0.5rem;
          border-radius: 999px;
          background: #ede9fe;
          color: #5b21b6;
          font-size: 0.75rem;
          font-weight: 500;
        "
      >
        {directionText(entry)}
      </span>
    ));

const applyIncrement = (
  rawAmount: number,
  countCell: Cell<number>,
  entriesCell: Cell<number[]>,
) => {
  const amount = Number.isFinite(rawAmount) ? rawAmount : 0;
  const current = countCell.get();
  const base = typeof current === "number" && Number.isFinite(current)
    ? current
    : 0;
  const next = base + amount;
  countCell.set(next);

  const existing = entriesCell.get();
  const list = Array.isArray(existing)
    ? existing.filter((value) => Number.isFinite(value))
    : [];
  entriesCell.set([...list, next]);

  return amount;
};

const createPresetIncrement = (amount: number) =>
  handler<unknown, { count: Cell<number>; entries: Cell<number[]> }>(
    (_event, { count, entries }) => {
      applyIncrement(amount, count, entries);
    },
  );

const applyCustomIncrement = handler<
  unknown,
  {
    field: Cell<string>;
    value: Cell<number>;
    count: Cell<number>;
    entries: Cell<number[]>;
  }
>((_event, { field, value, count, entries }) => {
  const applied = applyIncrement(value.get(), count, entries);
  field.set(formatNumber(applied));
});

const applyDirectionChange = (
  requested: SortDirection | undefined,
  directionCell: Cell<SortDirection>,
  historyCell: Cell<SortDirection[]>,
) => {
  const current = directionCell.get();
  const currentDirection = current === "desc" ? "desc" : "asc";
  const next = requested === "desc"
    ? "desc"
    : requested === "asc"
    ? "asc"
    : currentDirection === "asc"
    ? "desc"
    : "asc";

  if (next !== currentDirection) {
    directionCell.set(next);
  }

  const existing = historyCell.get();
  const history = Array.isArray(existing)
    ? existing.filter((value): value is SortDirection =>
      value === "asc" || value === "desc"
    )
    : [];
  historyCell.set([...history, next]);
};

const createDirectionAction = (requested: SortDirection | undefined) =>
  handler<
    unknown,
    {
      direction: Cell<SortDirection>;
      history: Cell<SortDirection[]>;
    }
  >((_event, { direction, history }) => {
    applyDirectionChange(requested, direction, history);
  });

export const counterSortDirectionToggleUx = recipe<SortDirectionToggleArgs>(
  "Counter With Sort Direction Toggle (UX)",
  ({ count, entries, direction }) => {
    const directionHistory = cell<SortDirection[]>([]);

    const safeCount = lift((value: number | undefined) =>
      typeof value === "number" && Number.isFinite(value) ? value : 0
    )(count);

    const safeEntries = lift((values: number[] | undefined) =>
      Array.isArray(values)
        ? values.filter((value) => Number.isFinite(value))
        : []
    )(entries);

    const safeDirection = lift((value: SortDirection | undefined) =>
      value === "desc" ? "desc" : "asc"
    )(direction);

    const sortedValues = lift(
      (
        input: { values: number[]; direction: SortDirection },
      ) => {
        const sorted = [...input.values].sort((left, right) =>
          input.direction === "desc" ? right - left : left - right
        );
        return sorted;
      },
    )({ values: safeEntries, direction: safeDirection });

    const directionHistoryView = lift(
      (history: SortDirection[] | undefined) =>
        Array.isArray(history)
          ? history.filter((value) => value === "desc" || value === "asc")
          : [],
    )(directionHistory);

    const directionLabel = lift(directionText)(safeDirection);
    const entryCount = lift((values: number[]) => values.length)(safeEntries);
    const sortedValuesLabel = lift((values: number[]) =>
      values.length === 0
        ? "[]"
        : `[${values.map((value) => formatNumber(value)).join(", ")}]`
    )(sortedValues);

    const valuesLabel = lift((values: number[]) =>
      values.length === 0
        ? "[]"
        : `[${values.map((value) => formatNumber(value)).join(", ")}]`
    )(safeEntries);

    const label = str`Sorted ${directionLabel}: ${sortedValuesLabel}`;

    const entryPreview = lift(({ current, sorted }: {
      current: number;
      sorted: number[];
    }) => {
      const first = sorted[0] ?? current;
      const last = sorted[sorted.length - 1] ?? current;
      return `${formatNumber(first)} → ${formatNumber(last)}`;
    })({ current: safeCount, sorted: sortedValues });

    const lastRecorded = lift((values: number[]) => {
      const last = values.length === 0 ? 0 : values[values.length - 1];
      return formatNumber(last);
    })(safeEntries);
    const currentDisplay = lift((value: number) => formatNumber(value))(
      safeCount,
    );

    const historyBadges = lift(mapHistory)(directionHistoryView);
    const entriesBadges = lift((values: number[]) =>
      mapEntries(values, "raw-entry")
    )(safeEntries);
    const sortedBadges = lift((values: number[]) =>
      mapEntries(values, "sorted-entry")
    )(sortedValues);

    const amountField = cell("1");
    const amountValue = lift(({ raw }: { raw: string }) => parseAmount(raw))({
      raw: amountField,
    });
    const amountDisplay = lift((value: number) => formatNumber(value))(
      amountValue,
    );

    const increment = recordValue({ count, entries });
    const toggleDirection = toggleSortDirection({
      direction,
      history: directionHistory,
    });

    const addOne = createPresetIncrement(1)({ count, entries });
    const subtractOne = createPresetIncrement(-1)({ count, entries });
    const addFive = createPresetIncrement(5)({ count, entries });
    const addCustom = applyCustomIncrement({
      field: amountField,
      value: amountValue,
      count,
      entries,
    });
    const setAscending = createDirectionAction("asc")({
      direction,
      history: directionHistory,
    });
    const setDescending = createDirectionAction("desc")({
      direction,
      history: directionHistory,
    });
    const flipDirection = createDirectionAction(undefined)({
      direction,
      history: directionHistory,
    });

    const name = str`Sort ${directionLabel} (${entryCount} entries)`;
    const status =
      str`Tracking ${entryCount} values sorted ${directionLabel}. Range ${entryPreview}.`;

    const ascendingActive = lift((value: SortDirection) => value === "asc")(
      safeDirection,
    );
    const descendingActive = lift((value: SortDirection) => value === "desc")(
      safeDirection,
    );

    return {
      [NAME]: name,
      [UI]: (
        <div style="
              display: flex;
              flex-direction: column;
              gap: 1.5rem;
              max-width: 32rem;
            ">
          <ct-card>
            <div
              slot="content"
              style="
                  display: flex;
                  flex-direction: column;
                  gap: 1rem;
                "
            >
              <div style="
                    display: grid;
                    gap: 0.75rem;
                    grid-template-columns: repeat(2, minmax(0, 1fr));
                  ">
                <div style="
                      background: #f8fafc;
                      border-radius: 0.75rem;
                      padding: 0.75rem;
                    ">
                  <span style="
                        display: block;
                        font-size: 0.75rem;
                        color: #475569;
                        text-transform: uppercase;
                        letter-spacing: 0.08em;
                      ">
                    Current total
                  </span>
                  <strong
                    data-testid="current-total"
                    style="
                        display: block;
                        font-size: 1.75rem;
                        color: #0f172a;
                      "
                  >
                    {currentDisplay}
                  </strong>
                  <span style="
                        display: block;
                        font-size: 0.75rem;
                        color: #64748b;
                      ">
                    Last recorded {lastRecorded}
                  </span>
                </div>
                <div style="
                      background: #eef2ff;
                      border-radius: 0.75rem;
                      padding: 0.75rem;
                    ">
                  <span style="
                        display: block;
                        font-size: 0.75rem;
                        color: #4338ca;
                        text-transform: uppercase;
                        letter-spacing: 0.08em;
                      ">
                    Sort direction
                  </span>
                  <strong
                    data-testid="current-direction"
                    style="
                        display: block;
                        font-size: 1.75rem;
                        color: #312e81;
                      "
                  >
                    {directionLabel}
                  </strong>
                  <span style="
                        display: block;
                        font-size: 0.75rem;
                        color: #6366f1;
                      ">
                    {sortedValuesLabel}
                  </span>
                </div>
              </div>

              <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                  ">
                <span style="
                      font-size: 0.85rem;
                      font-weight: 600;
                      color: #1f2937;
                    ">
                  Recorded values
                </span>
                <div
                  data-testid="raw-values"
                  style="
                      display: flex;
                      flex-wrap: wrap;
                      gap: 0.5rem;
                    "
                >
                  {entriesBadges}
                </div>
                <span style="
                      font-size: 0.85rem;
                      font-weight: 600;
                      color: #1f2937;
                    ">
                  Sorted preview
                </span>
                <div
                  data-testid="sorted-values"
                  style="
                      display: flex;
                      flex-wrap: wrap;
                      gap: 0.5rem;
                    "
                >
                  {sortedBadges}
                </div>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="content"
              style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                "
            >
              <div style="
                    display: flex;
                    gap: 0.5rem;
                    flex-wrap: wrap;
                    align-items: center;
                  ">
                <ct-button
                  data-testid="add-one"
                  onClick={addOne}
                >
                  +1
                </ct-button>
                <ct-button
                  data-testid="add-five"
                  onClick={addFive}
                >
                  +5
                </ct-button>
                <ct-button
                  data-testid="subtract-one"
                  variant="secondary"
                  onClick={subtractOne}
                >
                  -1
                </ct-button>
              </div>
              <div style="
                    display: flex;
                    gap: 0.5rem;
                    flex-wrap: wrap;
                    align-items: center;
                  ">
                <ct-input
                  id="custom-amount"
                  type="number"
                  step="1"
                  min="-9999"
                  max="9999"
                  aria-label="Custom amount"
                  style="max-width: 8rem;"
                  $value={amountField}
                >
                </ct-input>
                <ct-button
                  data-testid="add-custom"
                  variant="primary"
                  onClick={addCustom}
                >
                  Apply {amountDisplay}
                </ct-button>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="content"
              style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                "
            >
              <div style="
                    display: flex;
                    gap: 0.5rem;
                    flex-wrap: wrap;
                    align-items: center;
                  ">
                <ct-button
                  data-testid="set-ascending"
                  variant="ghost"
                  onClick={setAscending}
                  aria-pressed={ascendingActive}
                >
                  Ascending
                </ct-button>
                <ct-button
                  data-testid="set-descending"
                  variant="ghost"
                  onClick={setDescending}
                  aria-pressed={descendingActive}
                >
                  Descending
                </ct-button>
                <ct-button
                  data-testid="toggle-direction"
                  variant="primary"
                  onClick={flipDirection}
                >
                  Toggle direction
                </ct-button>
              </div>
              <div
                data-testid="direction-history"
                style="
                    display: flex;
                    flex-wrap: wrap;
                    gap: 0.5rem;
                  "
              >
                {historyBadges}
              </div>
              <div
                role="status"
                aria-live="polite"
                data-testid="status"
                style="
                    font-size: 0.9rem;
                    color: #334155;
                    line-height: 1.4;
                  "
              >
                {status}
              </div>
            </div>
          </ct-card>
        </div>
      ),
      count,
      entries,
      direction: safeDirection,
      current: safeCount,
      values: safeEntries,
      sortedValues,
      directionLabel,
      sortedValuesLabel,
      directionHistory: directionHistoryView,
      label,
      valuesLabel,
      entryCount,
      entryPreview,
      lastRecorded,
      currentDisplay,
      increment,
      toggleDirection,
      controls: {
        addOne,
        addFive,
        subtractOne,
        addCustom,
        setAscending,
        setDescending,
        flipDirection,
      },
      metrics: {
        status,
        amountValue,
      },
    };
  },
);

export default counterSortDirectionToggleUx;
