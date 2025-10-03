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
  toSchema,
  UI,
} from "commontools";

interface SummaryArgs {
  value: Default<number, 0>;
  step: Default<number, 1>;
  history: Default<number[], []>;
}

type CounterTrend = "up" | "down" | "flat";
type CounterParity = "even" | "odd";

interface AdjustmentRecord {
  sequence: number;
  delta: number;
  resulting: number;
  label: string;
}

interface SummaryInputs {
  current: Cell<number>;
  history: Cell<number[]>;
  step: Cell<number>;
  adjustments: Cell<AdjustmentRecord[]>;
}

interface SummarySnapshot {
  current: number;
  previous: number;
  delta: number;
  trend: CounterTrend;
  parity: CounterParity;
  average: number;
  historyCount: number;
  adjustmentCount: number;
  step: number;
  latestHistory: number;
  label: string;
}

interface CounterAdjustmentEvent {
  amount?: number;
  direction?: "increase" | "decrease";
  label?: string;
}

const toInteger = (input: unknown, fallback: number): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  return Math.trunc(input);
};

const sanitizeStep = (input: unknown): number => {
  const raw = toInteger(input, 1);
  const normalized = raw === 0 ? 1 : raw;
  return Math.abs(normalized);
};

const sanitizeHistory = (entries: number[] | undefined): number[] => {
  if (!Array.isArray(entries)) return [];
  return entries.map((item) => toInteger(item, 0));
};

const sanitizeAdjustments = (
  entries: AdjustmentRecord[] | undefined,
): AdjustmentRecord[] => {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => {
    const sequence = toInteger(entry?.sequence, 0);
    const delta = toInteger(entry?.delta, 0);
    const resulting = toInteger(entry?.resulting, 0);
    const label = typeof entry?.label === "string"
      ? entry.label
      : `Adjustment ${sequence}`;
    return { sequence, delta, resulting, label };
  });
};

const resolveAdjustment = (
  event: CounterAdjustmentEvent | undefined,
  fallbackStep: number,
): number => {
  if (!event) return fallbackStep;
  if (typeof event.amount === "number" && Number.isFinite(event.amount)) {
    return toInteger(event.amount, fallbackStep);
  }
  if (event.direction === "decrease") return -fallbackStep;
  if (event.direction === "increase") return fallbackStep;
  return fallbackStep;
};

const deriveTrend = (delta: number): CounterTrend => {
  if (delta > 0) return "up";
  if (delta < 0) return "down";
  return "flat";
};

const deriveParity = (value: number): CounterParity =>
  Math.abs(value % 2) === 0 ? "even" : "odd";

const formatNumber = (value: number): string => {
  const safe = Number.isFinite(value) ? value : 0;
  return `${toInteger(safe, 0)}`;
};

const formatTrend = (trend: CounterTrend): string => {
  if (trend === "up") return "📈";
  if (trend === "down") return "📉";
  return "➡️";
};

const describeAdjustments = (entries: AdjustmentRecord[]) => {
  if (entries.length === 0) {
    return [
      {
        id: "empty",
        title: "No adjustments yet",
        detail: "Use the controls to make your first adjustment.",
        delta: "",
      },
    ];
  }
  return entries
    .slice(-5)
    .reverse()
    .map((record) => {
      const sign = record.delta >= 0 ? "+" : "";
      return {
        id: `adjustment-${record.sequence}`,
        title: record.label,
        detail: `Resulted in ${formatNumber(record.resulting)}`,
        delta: `${sign}${formatNumber(record.delta)}`,
      };
    });
};

export const counterWithDerivedSummaryUx = recipe<SummaryArgs>(
  "Counter With Derived Summary (UX)",
  ({ value, step, history }) => {
    const sequence = cell(0);
    const adjustments = cell<AdjustmentRecord[]>([]);

    const currentValue = lift((input: number | undefined) =>
      toInteger(input, 0)
    )(value);
    const stepValue = lift((input: number | undefined) => sanitizeStep(input))(
      step,
    );
    const historyView = lift(sanitizeHistory)(history);
    const adjustmentsView = lift(sanitizeAdjustments)(adjustments);
    const sequenceView = derive(sequence, (count) => toInteger(count ?? 0, 0));

    const summary = lift(
      toSchema<SummaryInputs>(),
      toSchema<SummarySnapshot>(),
      ({ current, history, step, adjustments }) => {
        const currentNumber = toInteger(current.get(), 0);
        const historyList = sanitizeHistory(history.get());
        const adjustmentList = sanitizeAdjustments(adjustments.get());
        const lastAdjustment = adjustmentList.at(-1);
        const delta = lastAdjustment?.delta ?? 0;
        const previous = currentNumber - delta;
        const latestHistory = historyList.at(-1) ?? currentNumber;
        const recordsTotal = historyList.reduce(
          (sum, entry) => sum + entry,
          0,
        );
        const divisor = historyList.length === 0 ? 1 : historyList.length;
        const averageBase = historyList.length === 0
          ? currentNumber
          : recordsTotal / divisor;
        const average = Math.round(averageBase * 100) / 100;
        const sanitizedStep = sanitizeStep(step.get());
        const trend = deriveTrend(delta);
        const parity = deriveParity(currentNumber);
        const label =
          `Current ${currentNumber} (${trend}) avg ${average} step ${sanitizedStep}`;

        return {
          current: currentNumber,
          previous,
          delta,
          trend,
          parity,
          average,
          historyCount: historyList.length,
          adjustmentCount: adjustmentList.length,
          step: sanitizedStep,
          latestHistory,
          label,
        };
      },
    )({
      current: currentValue,
      history: historyView,
      step: stepValue,
      adjustments: adjustmentsView,
    });

    const trendText = derive(summary, (snapshot) => snapshot.trend);
    const parityText = derive(summary, (snapshot) => snapshot.parity);
    const summaryLabel = derive(summary, (snapshot) => snapshot.label);

    const currentDisplay = derive(currentValue, (value) => formatNumber(value));
    const stepDisplay = derive(stepValue, (value) => formatNumber(value));
    const averageDisplay = derive(summary, (snapshot) => {
      const avg = Number.isFinite(snapshot.average) ? snapshot.average : 0;
      return Math.round(avg * 100) / 100;
    });
    const deltaDisplay = derive(summary, (snapshot) => {
      const sign = snapshot.delta >= 0 ? "+" : "";
      return `${sign}${formatNumber(snapshot.delta)}`;
    });
    const previousDisplay = derive(
      summary,
      (snapshot) => formatNumber(snapshot.previous),
    );
    const historyCountDisplay = derive(
      summary,
      (snapshot) => formatNumber(snapshot.historyCount),
    );
    const adjustmentCountDisplay = derive(
      summary,
      (snapshot) => formatNumber(snapshot.adjustmentCount),
    );
    const trendIcon = lift((trend: CounterTrend) => formatTrend(trend))(
      trendText,
    );

    const adjustmentList = derive(
      adjustmentsView,
      (entries) => describeAdjustments(entries),
    );
    const adjustmentCards = lift(({ items }: {
      items: ReturnType<typeof describeAdjustments>;
    }) =>
      items.map((item) => (
        <div
          key={item.id}
          style="
            border: 1px solid #e2e8f0;
            border-radius: 0.75rem;
            padding: 0.75rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 0.75rem;
          "
        >
          <div style="
              display: flex;
              flex-direction: column;
              gap: 0.25rem;
              flex: 1;
            ">
            <strong style="font-size: 0.95rem; color: #0f172a;">
              {item.title}
            </strong>
            <span style="font-size: 0.8rem; color: #475569;">
              {item.detail}
            </span>
          </div>
          {item.delta && (
            <span style="
                font-family: monospace;
                font-size: 0.9rem;
                font-weight: 600;
                color: #3b82f6;
                background: #eff6ff;
                padding: 0.25rem 0.5rem;
                border-radius: 0.5rem;
                white-space: nowrap;
              ">
              {item.delta}
            </span>
          )}
        </div>
      ))
    )({ items: adjustmentList });

    const amountField = cell<string>("1");
    const labelField = cell<string>("");

    const amountCandidate = derive(amountField, (text) => {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) {
        return 1;
      }
      return toInteger(parsed, 1);
    });

    const stepField = cell<string>("1");
    const stepCandidate = derive(stepField, (text) => {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) {
        return 1;
      }
      return sanitizeStep(parsed);
    });

    const applyCustomAdjustment = handler<
      unknown,
      {
        value: Cell<number>;
        step: Cell<number>;
        history: Cell<number[]>;
        sequence: Cell<number>;
        adjustments: Cell<AdjustmentRecord[]>;
        amount: Cell<number>;
        label: Cell<string>;
      }
    >((
      _event,
      { amount, label, value, step, history, sequence, adjustments },
    ) => {
      const base = toInteger(value.get(), 0);
      const delta = toInteger(amount.get(), 1);
      const next = base + delta;
      value.set(next);

      const historyValue = history.get();
      if (Array.isArray(historyValue)) {
        history.push(next);
      } else {
        history.set([next]);
      }

      const currentSequence = toInteger(sequence.get(), 0) + 1;
      sequence.set(currentSequence);

      const customLabel = label.get().trim();
      const record: AdjustmentRecord = {
        sequence: currentSequence,
        delta,
        resulting: next,
        label: customLabel.length > 0
          ? customLabel
          : `Adjustment ${currentSequence}`,
      };

      adjustments.push(record);
      label.set("");
    })({
      value,
      step,
      history,
      sequence,
      adjustments,
      amount: amountCandidate,
      label: labelField,
    });

    const applyIncrease = handler<
      unknown,
      {
        value: Cell<number>;
        step: Cell<number>;
        history: Cell<number[]>;
        sequence: Cell<number>;
        adjustments: Cell<AdjustmentRecord[]>;
      }
    >((_event, { value, step, history, sequence, adjustments }) => {
      const base = toInteger(value.get(), 0);
      const stepSize = sanitizeStep(step.get());
      const next = base + stepSize;
      value.set(next);

      const historyValue = history.get();
      if (Array.isArray(historyValue)) {
        history.push(next);
      } else {
        history.set([next]);
      }

      const currentSequence = toInteger(sequence.get(), 0) + 1;
      sequence.set(currentSequence);

      const record: AdjustmentRecord = {
        sequence: currentSequence,
        delta: stepSize,
        resulting: next,
        label: `Increase ${currentSequence}`,
      };

      adjustments.push(record);
    })({ value, step, history, sequence, adjustments });

    const applyDecrease = handler<
      unknown,
      {
        value: Cell<number>;
        step: Cell<number>;
        history: Cell<number[]>;
        sequence: Cell<number>;
        adjustments: Cell<AdjustmentRecord[]>;
      }
    >((_event, { value, step, history, sequence, adjustments }) => {
      const base = toInteger(value.get(), 0);
      const stepSize = sanitizeStep(step.get());
      const next = base - stepSize;
      value.set(next);

      const historyValue = history.get();
      if (Array.isArray(historyValue)) {
        history.push(next);
      } else {
        history.set([next]);
      }

      const currentSequence = toInteger(sequence.get(), 0) + 1;
      sequence.set(currentSequence);

      const record: AdjustmentRecord = {
        sequence: currentSequence,
        delta: -stepSize,
        resulting: next,
        label: `Decrease ${currentSequence}`,
      };

      adjustments.push(record);
    })({ value, step, history, sequence, adjustments });

    const updateStepSize = handler<
      unknown,
      {
        step: Cell<number>;
        candidate: Cell<number>;
      }
    >((_event, { step, candidate }) => {
      const sanitized = sanitizeStep(candidate.get());
      step.set(sanitized);
    })({ step, candidate: stepCandidate });

    const syncAmountField = compute(() => {
      const text = formatNumber(amountCandidate.get());
      if (amountField.get() !== text) {
        amountField.set(text);
      }
    });

    const syncStepField = compute(() => {
      const text = formatNumber(stepValue.get());
      if (stepField.get() !== text) {
        stepField.set(text);
      }
    });

    const name = str`Derived summary counter (${currentDisplay})`;
    const status = str`Current ${currentDisplay} • Trend ${trendIcon} • \
Parity ${parityText} • Average ${averageDisplay} • ${adjustmentCountDisplay} \
adjustments`;

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 36rem;
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
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.25rem;
                ">
                <span style="
                    color: #475569;
                    font-size: 0.75rem;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                  ">
                  Summary analytics
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Track trends, parity, and history averages
                </h2>
              </div>

              <div style="
                  display: grid;
                  grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
                  gap: 0.75rem;
                ">
                <div style="
                    background: #f8fafc;
                    border-radius: 0.75rem;
                    padding: 0.75rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <span style="font-size: 0.75rem; color: #475569;">
                    Current value
                  </span>
                  <strong
                    data-testid="current-value"
                    style="font-size: 1.5rem; color: #0f172a;"
                  >
                    {currentDisplay}
                  </strong>
                </div>
                <div style="
                    background: #ecfdf5;
                    border-radius: 0.75rem;
                    padding: 0.75rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <span style="font-size: 0.75rem; color: #047857;">
                    Trend
                  </span>
                  <strong
                    data-testid="trend"
                    style="font-size: 1.5rem; color: #065f46;"
                  >
                    {trendIcon} {trendText}
                  </strong>
                </div>
                <div style="
                    background: #fef3c7;
                    border-radius: 0.75rem;
                    padding: 0.75rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <span style="font-size: 0.75rem; color: #92400e;">
                    Parity
                  </span>
                  <strong style="font-size: 1.5rem; color: #78350f;">
                    {parityText}
                  </strong>
                </div>
                <div style="
                    background: #ede9fe;
                    border-radius: 0.75rem;
                    padding: 0.75rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <span style="font-size: 0.75rem; color: #5b21b6;">
                    Average
                  </span>
                  <strong
                    data-testid="average"
                    style="font-size: 1.5rem; color: #4c1d95;"
                  >
                    {averageDisplay}
                  </strong>
                </div>
              </div>

              <div style="
                  background: #f1f5f9;
                  border-radius: 0.75rem;
                  padding: 0.75rem;
                  display: flex;
                  justify-content: space-between;
                  align-items: center;
                  gap: 1rem;
                ">
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.1rem;
                  ">
                  <span style="font-size: 0.75rem; color: #64748b;">
                    Last change
                  </span>
                  <strong style="font-size: 1.1rem; color: #1e293b;">
                    {deltaDisplay}
                  </strong>
                </div>
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.1rem;
                  ">
                  <span style="font-size: 0.75rem; color: #64748b;">
                    Previous value
                  </span>
                  <strong style="font-size: 1.1rem; color: #1e293b;">
                    {previousDisplay}
                  </strong>
                </div>
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.1rem;
                  ">
                  <span style="font-size: 0.75rem; color: #64748b;">
                    History entries
                  </span>
                  <strong style="font-size: 1.1rem; color: #1e293b;">
                    {historyCountDisplay}
                  </strong>
                </div>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
                <div style="
                    display: grid;
                    grid-template-columns: 1fr auto;
                    gap: 0.75rem;
                    align-items: flex-end;
                  ">
                  <div style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.4rem;
                    ">
                    <label
                      for="step-size"
                      style="
                        font-size: 0.85rem;
                        font-weight: 500;
                        color: #334155;
                      "
                    >
                      Step size
                    </label>
                    <ct-input
                      id="step-size"
                      type="number"
                      min="1"
                      step="1"
                      $value={stepField}
                      aria-label="Configure the default step size"
                    >
                    </ct-input>
                  </div>
                  <ct-button onClick={updateStepSize}>
                    Update to {stepCandidate}
                  </ct-button>
                </div>

                <div style="
                    display: flex;
                    gap: 0.5rem;
                    flex-wrap: wrap;
                  ">
                  <ct-button onClick={applyIncrease}>
                    Increase by {stepDisplay}
                  </ct-button>
                  <ct-button variant="secondary" onClick={applyDecrease}>
                    Decrease by {stepDisplay}
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
                    font-weight: 600;
                    color: #0f172a;
                  ">
                  Custom adjustment
                </h3>
                <div style="
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 0.75rem;
                  ">
                  <div style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.4rem;
                    ">
                    <label
                      for="adjustment-amount"
                      style="
                        font-size: 0.85rem;
                        font-weight: 500;
                        color: #334155;
                      "
                    >
                      Amount (+ or -)
                    </label>
                    <ct-input
                      id="adjustment-amount"
                      type="number"
                      step="1"
                      $value={amountField}
                      aria-label="Enter adjustment amount"
                    >
                    </ct-input>
                  </div>
                  <div style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.4rem;
                    ">
                    <label
                      for="adjustment-label"
                      style="
                        font-size: 0.85rem;
                        font-weight: 500;
                        color: #334155;
                      "
                    >
                      Label (optional)
                    </label>
                    <ct-input
                      id="adjustment-label"
                      type="text"
                      placeholder="e.g., Manual correction"
                      $value={labelField}
                      aria-label="Enter adjustment label"
                    >
                    </ct-input>
                  </div>
                </div>
                <ct-button onClick={applyCustomAdjustment}>
                  Apply adjustment ({deltaDisplay} → change by{" "}
                  {amountCandidate})
                </ct-button>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Adjustment history
              </h3>
              <ct-badge variant="outline">
                {adjustmentCountDisplay} adjustments
              </ct-badge>
            </div>
            <div
              slot="content"
              style="
                display: grid;
                gap: 0.5rem;
              "
            >
              {adjustmentCards}
            </div>
          </ct-card>

          <div
            role="status"
            aria-live="polite"
            data-testid="status"
            style="font-size: 0.85rem; color: #475569;"
          >
            {status}
          </div>
        </div>
      ),
      value,
      step,
      history: historyView,
      adjustments: adjustmentsView,
      currentValue,
      stepValue,
      sequence: sequenceView,
      summary,
      summaryLabel,
      trend: trendText,
      parity: parityText,
      currentDisplay,
      stepDisplay,
      averageDisplay,
      deltaDisplay,
      previousDisplay,
      historyCountDisplay,
      adjustmentCountDisplay,
      trendIcon,
      adjustmentList,
      adjustmentCards,
      name,
      status,
      inputs: {
        amountField,
        labelField,
        stepField,
        amountCandidate,
        stepCandidate,
      },
      controls: {
        applyCustomAdjustment,
        applyIncrease,
        applyDecrease,
        updateStepSize,
      },
      effects: {
        syncAmountField,
        syncStepField,
      },
    };
  },
);

export default counterWithDerivedSummaryUx;
