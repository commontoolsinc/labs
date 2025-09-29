/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  compute,
  Default,
  derive,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

interface FilteredProjectionArgs {
  counters: Default<number[], []>;
  threshold: Default<number, 0>;
}

const asNumber = (input: unknown): number | undefined => {
  if (typeof input !== "number" || !Number.isFinite(input)) return undefined;
  return input;
};

const readThreshold = (input: unknown, fallback: number): number => {
  const value = asNumber(input);
  if (typeof value === "number") return value;
  return fallback;
};

const appendCounterMutation = (
  value: number,
  context: { counters: Cell<number[]> },
) => {
  const current = context.counters.get();
  const list = Array.isArray(current) ? current.slice() : [];
  list.push(value);
  context.counters.set(list);
};

const appendCounter = handler<
  { value?: number } | number | undefined,
  { counters: Cell<number[]> }
>((event, context) => {
  const nextValue = asNumber(
    typeof event === "number" ? event : event?.value,
  ) ?? 0;
  appendCounterMutation(nextValue, context);
});

const replaceCounter = handler<
  { index?: number; value?: number } | undefined,
  { counters: Cell<number[]> }
>((event, context) => {
  if (typeof event?.index !== "number") return;
  const rawIndex = Math.trunc(event.index);
  if (!Number.isFinite(rawIndex) || rawIndex < 0) return;
  const current = context.counters.get();
  if (!Array.isArray(current)) return;
  if (rawIndex >= current.length) return;
  const list = current.slice();
  list[rawIndex] = asNumber(event?.value) ?? 0;
  context.counters.set(list);
});

const updateThreshold = handler<
  { value?: number; threshold?: number } | number | undefined,
  { threshold: Cell<number> }
>((event, context) => {
  const current = asNumber(context.threshold.get()) ?? 0;
  const resolved = typeof event === "number"
    ? event
    : event?.value ?? event?.threshold;
  const nextThreshold = readThreshold(resolved, current);
  context.threshold.set(nextThreshold);
});

const appendFromField = handler<
  unknown,
  { counters: Cell<number[]>; valueField: Cell<string> }
>((_event, context) => {
  const text = context.valueField.get();
  const parsed = Number(text);
  const value = Number.isFinite(parsed) ? parsed : 0;
  appendCounterMutation(value, context);
  context.valueField.set("");
});

const setThresholdFromField = handler<
  unknown,
  { threshold: Cell<number>; thresholdField: Cell<string> }
>((_event, context) => {
  const text = context.thresholdField.get();
  const parsed = Number(text);
  const value = Number.isFinite(parsed) ? parsed : 0;
  context.threshold.set(value);
});

const clearCounters = handler<
  unknown,
  { counters: Cell<number[]>; valueField: Cell<string> }
>((_event, context) => {
  context.counters.set([]);
  context.valueField.set("");
});

export const counterFilteredProjectionUx = recipe<FilteredProjectionArgs>(
  "Counter With Filtered Projection (UX)",
  ({ counters, threshold }) => {
    const valueField = cell<string>("");
    const thresholdField = cell<string>("0");

    const sanitizedCounters = lift((entries: number[] | undefined) => {
      if (!Array.isArray(entries)) return [] as number[];
      return entries.map((entry) => asNumber(entry) ?? 0);
    })(counters);

    const thresholdValue = lift((input: number | undefined) =>
      readThreshold(input, 0)
    )(threshold);

    const filtered = lift(
      (
        inputs: { values: number[]; threshold: number },
      ): number[] => inputs.values.filter((value) => value >= inputs.threshold),
    )({ values: sanitizedCounters, threshold: thresholdValue });

    const excluded = lift(
      (
        inputs: { values: number[]; threshold: number },
      ): number[] => inputs.values.filter((value) => value < inputs.threshold),
    )({ values: sanitizedCounters, threshold: thresholdValue });

    const totalCount = derive(sanitizedCounters, (values) => values.length);
    const filteredCount = derive(filtered, (values) => values.length);
    const excludedCount = derive(excluded, (values) => values.length);

    const filteredLabel = lift((values: number[]) => values.join(", "))(
      filtered,
    );
    const excludedLabel = lift((values: number[]) => values.join(", "))(
      excluded,
    );

    const summary =
      str`Filtered ${filteredCount} of ${totalCount} >= ${thresholdValue}`;

    const name = str`Filtered Projection (${filteredCount}/${totalCount})`;

    const append = appendFromField({ counters, valueField });
    const setThreshold = setThresholdFromField({ threshold, thresholdField });
    const clear = clearCounters({ counters, valueField });

    const syncThresholdField = compute(() => {
      const value = thresholdValue.get();
      const text = String(value);
      if (thresholdField.get() !== text) {
        thresholdField.set(text);
      }
    });

    const filteredListUi = lift(
      (inputs: { filtered: number[]; excluded: number[] }) => {
        const filteredValues = inputs.filtered;
        const excludedValues = inputs.excluded;

        if (filteredValues.length === 0 && excludedValues.length === 0) {
          return (
            <div style="
                text-align: center;
                padding: 2rem;
                color: #64748b;
                font-style: italic;
              ">
              No counters added yet. Add some values to see filtering in action.
            </div>
          );
        }

        const filteredItems = filteredValues.map((val, idx) => {
          const bgColor = "#dcfce7";
          const borderColor = "#86efac";
          const textColor = "#166534";
          return (
            <div
              key={String(idx)}
              style={"background: " + bgColor +
                "; border: 2px solid " + borderColor +
                "; border-radius: 0.5rem; padding: 0.75rem; text-align: center; font-weight: 600; color: " +
                textColor + "; font-size: 1.25rem;"}
            >
              {String(val)}
            </div>
          );
        });

        const excludedItems = excludedValues.map((val, idx) => {
          const bgColor = "#fef2f2";
          const borderColor = "#fca5a5";
          const textColor = "#991b1b";
          return (
            <div
              key={String(idx)}
              style={"background: " + bgColor +
                "; border: 2px solid " + borderColor +
                "; border-radius: 0.5rem; padding: 0.75rem; text-align: center; font-weight: 600; color: " +
                textColor + "; font-size: 1.25rem; opacity: 0.6;"}
            >
              {String(val)}
            </div>
          );
        });

        return (
          <div style="display: flex; flex-direction: column; gap: 1rem;">
            <div>
              <h3 style="
                  margin: 0 0 0.75rem 0;
                  font-size: 0.95rem;
                  color: #0f172a;
                  font-weight: 600;
                ">
                <span style="
                    display: inline-block;
                    width: 1rem;
                    height: 1rem;
                    background: #22c55e;
                    border-radius: 50%;
                    margin-right: 0.5rem;
                    vertical-align: middle;
                  ">
                </span>
                Included ({String(filteredValues.length)})
              </h3>
              {filteredValues.length > 0
                ? (
                  <div style="
                      display: grid;
                      grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
                      gap: 0.5rem;
                    ">
                    {filteredItems}
                  </div>
                )
                : (
                  <div style="
                      padding: 1rem;
                      text-align: center;
                      color: #94a3b8;
                      font-size: 0.85rem;
                      font-style: italic;
                    ">
                    No values meet the threshold
                  </div>
                )}
            </div>

            <div>
              <h3 style="
                  margin: 0 0 0.75rem 0;
                  font-size: 0.95rem;
                  color: #0f172a;
                  font-weight: 600;
                ">
                <span style="
                    display: inline-block;
                    width: 1rem;
                    height: 1rem;
                    background: #ef4444;
                    border-radius: 50%;
                    margin-right: 0.5rem;
                    vertical-align: middle;
                  ">
                </span>
                Excluded ({String(excludedValues.length)})
              </h3>
              {excludedValues.length > 0
                ? (
                  <div style="
                      display: grid;
                      grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
                      gap: 0.5rem;
                    ">
                    {excludedItems}
                  </div>
                )
                : (
                  <div style="
                      padding: 1rem;
                      text-align: center;
                      color: #94a3b8;
                      font-size: 0.85rem;
                      font-style: italic;
                    ">
                    All values meet the threshold
                  </div>
                )}
            </div>
          </div>
        );
      },
    )({ filtered, excluded });

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 48rem;
          ">
          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1.25rem;
              "
            >
              <div style="display: flex; flex-direction: column; gap: 0.35rem;">
                <span style="
                    color: #475569;
                    font-size: 0.75rem;
                    text-transform: uppercase;
                    letter-spacing: 0.08em;
                  ">
                  Filtered projection pattern
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.25rem;
                    line-height: 1.4;
                    color: #0f172a;
                  ">
                  Filter counters by threshold
                </h2>
                <p style="
                    margin: 0;
                    font-size: 0.9rem;
                    color: #64748b;
                    line-height: 1.5;
                  ">
                  Add numeric values and watch them automatically separate into
                  included and excluded groups based on your threshold. Perfect
                  for data filtering and projection scenarios.
                </p>
              </div>

              <div style="
                  display: grid;
                  gap: 0.75rem;
                  grid-template-columns: repeat(3, minmax(0, 1fr));
                ">
                <div style="
                    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
                    border-radius: 0.75rem;
                    padding: 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                    color: white;
                  ">
                  <span style="
                      font-size: 0.75rem;
                      opacity: 0.9;
                    ">
                    Total
                  </span>
                  <strong
                    data-testid="total-count"
                    style="font-size: 2rem; line-height: 1;"
                  >
                    {totalCount}
                  </strong>
                </div>

                <div style="
                    background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
                    border-radius: 0.75rem;
                    padding: 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                    color: white;
                  ">
                  <span style="
                      font-size: 0.75rem;
                      opacity: 0.9;
                    ">
                    Included
                  </span>
                  <strong
                    data-testid="filtered-count"
                    style="font-size: 2rem; line-height: 1;"
                  >
                    {filteredCount}
                  </strong>
                </div>

                <div style="
                    background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
                    border-radius: 0.75rem;
                    padding: 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                    color: white;
                  ">
                  <span style="
                      font-size: 0.75rem;
                      opacity: 0.9;
                    ">
                    Excluded
                  </span>
                  <strong
                    data-testid="excluded-count"
                    style="font-size: 2rem; line-height: 1;"
                  >
                    {excludedCount}
                  </strong>
                </div>
              </div>

              <div style="
                  background: #f8fafc;
                  border-radius: 0.75rem;
                  padding: 1rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
                <h3 style="
                    margin: 0;
                    font-size: 0.95rem;
                    color: #0f172a;
                    font-weight: 600;
                  ">
                  Add value
                </h3>
                <div style="
                    display: flex;
                    gap: 0.5rem;
                    align-items: center;
                  ">
                  <ct-input
                    data-testid="value-input"
                    type="number"
                    placeholder="Enter a number"
                    $value={valueField}
                    aria-label="Enter value to add"
                    style="flex: 1;"
                  >
                  </ct-input>
                  <ct-button
                    data-testid="add-button"
                    onClick={append}
                    variant="primary"
                  >
                    Add
                  </ct-button>
                  <ct-button
                    data-testid="clear-button"
                    onClick={clear}
                    variant="secondary"
                  >
                    Clear All
                  </ct-button>
                </div>
              </div>

              <div style="
                  border-top: 1px solid #e2e8f0;
                  padding-top: 1rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
                <h3 style="
                    margin: 0;
                    font-size: 0.95rem;
                    color: #0f172a;
                    font-weight: 600;
                  ">
                  Set threshold
                </h3>
                <div style="
                    display: flex;
                    gap: 0.5rem;
                    align-items: center;
                  ">
                  <label style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                      white-space: nowrap;
                    ">
                    Include values ≥
                  </label>
                  <ct-input
                    data-testid="threshold-input"
                    type="number"
                    $value={thresholdField}
                    aria-label="Set threshold value"
                    style="width: 120px;"
                  >
                  </ct-input>
                  <ct-button
                    data-testid="set-threshold-button"
                    onClick={setThreshold}
                  >
                    Apply
                  </ct-button>
                </div>
                <span style="font-size: 0.75rem; color: #64748b;">
                  Values greater than or equal to the threshold will be
                  included.
                </span>
              </div>

              <div style="
                  border-top: 1px solid #e2e8f0;
                  padding-top: 1rem;
                ">
                {filteredListUi}
              </div>
            </div>
          </ct-card>

          <div
            role="status"
            aria-live="polite"
            data-testid="status"
            style="font-size: 0.85rem; color: #475569;"
          >
            {summary}
          </div>
        </div>
      ),
      counters,
      threshold,
      sanitizedCounters,
      thresholdValue,
      filtered,
      excluded,
      filteredCount,
      excludedCount,
      totalCount,
      filteredLabel,
      excludedLabel,
      summary,
      append: appendCounter({ counters }),
      replace: replaceCounter({ counters }),
      setThreshold: updateThreshold({ threshold }),
      controls: {
        append,
        setThreshold,
        clear,
      },
      inputs: {
        valueField,
        thresholdField,
      },
      effects: {
        syncThresholdField,
      },
    };
  },
);

export default counterFilteredProjectionUx;
