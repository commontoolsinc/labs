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

interface RangeSliderArgs {
  min: Default<number, 0>;
  max: Default<number, 100>;
  value: Default<number, 50>;
  step: Default<number, 5>;
}

interface SliderSnapshot {
  interaction: number;
  value: number;
  percentage: number;
}

const toFiniteNumber = (input: unknown, fallback: number): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  return input;
};

const clampNumber = (value: number, minValue: number, maxValue: number) => {
  if (value < minValue) return minValue;
  if (value > maxValue) return maxValue;
  return value;
};

const normalizePercentage = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  if (value > 1) return clampNumber(value / 100, 0, 1);
  return clampNumber(value, 0, 1);
};

const computePercentage = (
  value: number,
  minValue: number,
  maxValue: number,
) => {
  const span = maxValue - minValue;
  if (!Number.isFinite(span) || span <= 0) return 0;
  const ratio = clampNumber((value - minValue) / span, 0, 1);
  const percent = ratio * 100;
  return Math.round(percent * 10) / 10;
};

const sanitizeSnapshots = (entries: SliderSnapshot[] | undefined) => {
  if (!Array.isArray(entries)) return [] as SliderSnapshot[];
  return entries.map((entry) => ({
    interaction: toFiniteNumber(entry?.interaction, 0),
    value: toFiniteNumber(entry?.value, 0),
    percentage: toFiniteNumber(entry?.percentage, 0),
  }));
};

const formatNumber = (value: number): string => {
  const safe = Number.isFinite(value) ? value : 0;
  const rounded = Math.round(safe * 100) / 100;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(2);
};

const formatPercentage = (value: number): string => {
  const safe = Number.isFinite(value) ? value : 0;
  return `${Math.round(safe * 10) / 10}`;
};

const describeHistory = (entries: SliderSnapshot[]) => {
  if (entries.length === 0) {
    return [
      {
        id: "empty",
        summary: "No interactions yet",
        detail: "Start adjusting the slider to record history.",
      },
    ];
  }
  return entries.map((entry) => ({
    id: `interaction-${entry.interaction}`,
    summary: `#${entry.interaction} → ${formatNumber(entry.value)}`,
    detail: `${formatPercentage(entry.percentage)}% of range`,
  }));
};

const applySliderUpdate = (
  context: {
    value: Cell<number>;
    min: Cell<number>;
    max: Cell<number>;
    interactions: Cell<number>;
    history: Cell<SliderSnapshot[]>;
  },
  desired: number,
) => {
  const rawMin = context.min.get();
  const rawMax = context.max.get();
  const minValue = toFiniteNumber(rawMin, 0);
  const maxCandidate = toFiniteNumber(rawMax, minValue + 100);
  const maxValue = maxCandidate > minValue ? maxCandidate : minValue + 100;
  const next = clampNumber(
    toFiniteNumber(desired, minValue),
    minValue,
    maxValue,
  );

  context.value.set(next);

  const counter = toFiniteNumber(context.interactions.get(), 0) + 1;
  context.interactions.set(counter);
  const percentage = computePercentage(next, minValue, maxValue);
  const snapshot: SliderSnapshot = {
    interaction: counter,
    value: next,
    percentage,
  };

  const existing = context.history.get();
  const list = Array.isArray(existing) ? existing.slice() : [];
  list.push(snapshot);
  context.history.set(list);
};

const setSliderValue = handler(
  (
    event: { value?: number; percentage?: number } | undefined,
    context: {
      value: Cell<number>;
      min: Cell<number>;
      max: Cell<number>;
      interactions: Cell<number>;
      history: Cell<SliderSnapshot[]>;
    },
  ) => {
    const rawMin = context.min.get();
    const rawMax = context.max.get();
    const minValue = toFiniteNumber(rawMin, 0);
    const maxCandidate = toFiniteNumber(rawMax, minValue + 100);
    const maxValue = maxCandidate > minValue ? maxCandidate : minValue + 100;

    if (typeof event?.value === "number") {
      applySliderUpdate(context, event.value);
      return;
    }
    if (typeof event?.percentage === "number") {
      const ratio = normalizePercentage(event.percentage);
      const desired = minValue + (maxValue - minValue) * ratio;
      applySliderUpdate(context, desired);
      return;
    }

    const current = toFiniteNumber(context.value.get(), minValue);
    applySliderUpdate(context, current);
  },
);

const nudgeSlider = handler(
  (
    event: { direction?: "increase" | "decrease"; ticks?: number } | undefined,
    context: {
      value: Cell<number>;
      min: Cell<number>;
      max: Cell<number>;
      step: Cell<number>;
      interactions: Cell<number>;
      history: Cell<SliderSnapshot[]>;
    },
  ) => {
    const direction = event?.direction === "decrease" ? -1 : 1;
    const ticks = typeof event?.ticks === "number"
      ? Math.max(1, Math.abs(Math.trunc(event.ticks)))
      : 1;
    const rawStep = context.step.get();
    const baseStep = toFiniteNumber(rawStep, 1);
    const stepSize = baseStep > 0 ? baseStep : 1;

    const current = toFiniteNumber(context.value.get(), 0);
    const desired = current + stepSize * ticks * direction;
    applySliderUpdate(context, desired);
  },
);

export const counterRangeSliderUx = recipe<RangeSliderArgs>(
  "Counter Range Slider (UX)",
  ({ min, max, value, step }) => {
    const interactions = cell(0);
    const history = cell<SliderSnapshot[]>([]);

    const sliderState = lift(({ min: rawMin, max: rawMax, value: rawValue }: {
      min: number;
      max: number;
      value: number;
    }) => {
      const minValue = toFiniteNumber(rawMin, 0);
      const maxCandidate = toFiniteNumber(rawMax, minValue + 100);
      const maxValue = maxCandidate > minValue ? maxCandidate : minValue + 100;
      const current = clampNumber(
        toFiniteNumber(rawValue, minValue),
        minValue,
        maxValue,
      );
      const span = maxValue - minValue;
      return {
        min: minValue,
        max: maxValue,
        span: span > 0 ? span : 1,
        value: current,
      };
    })({ min, max, value });

    const currentValue = derive(sliderState, (state) => state.value);
    const minView = derive(sliderState, (state) => state.min);
    const maxView = derive(sliderState, (state) => state.max);
    const sliderSpan = derive(sliderState, (state) => state.span);
    const percentage = derive(
      sliderState,
      (state) => computePercentage(state.value, state.min, state.max),
    );

    const stepSize = lift((raw: number | undefined) => {
      const normalized = toFiniteNumber(raw, 1);
      return normalized > 0 ? normalized : 1;
    })(step);

    const interactionCount = lift((count: number | undefined) =>
      toFiniteNumber(count, 0)
    )(interactions);
    const historyView = lift(sanitizeSnapshots)(history);

    const rangeSummary = str`Range ${minView} to ${maxView}`;
    const label = str`Slider at ${currentValue} (${percentage}%)`;

    const currentDisplay = derive(currentValue, (state) => formatNumber(state));
    const minDisplay = derive(minView, (state) => formatNumber(state));
    const maxDisplay = derive(maxView, (state) => formatNumber(state));
    const percentageDisplay = derive(
      percentage,
      (state) => formatPercentage(state),
    );
    const stepDisplay = derive(stepSize, (state) => formatNumber(state));
    const spanDisplay = derive(sliderSpan, (state) => formatNumber(state));
    const interactionDisplay = derive(
      interactionCount,
      (count) => formatNumber(count),
    );

    const historyRows = derive(
      historyView,
      (entries) => describeHistory(entries),
    );
    const historyCards = lift(({ entries }: {
      entries: ReturnType<typeof describeHistory>;
    }) =>
      entries.map((entry) => (
        <div
          key={entry.id}
          style="
            border: 1px solid #e2e8f0;
            border-radius: 0.75rem;
            padding: 0.75rem;
            display: flex;
            flex-direction: column;
            gap: 0.25rem;
          "
        >
          <strong style="font-size: 0.95rem; color: #0f172a;">
            {entry.summary}
          </strong>
          <span style="font-size: 0.8rem; color: #475569;">
            {entry.detail}
          </span>
        </div>
      ))
    )({ entries: historyRows });

    const valueField = cell<string>("0");
    const percentageField = cell<string>("0");
    const ticksField = cell<string>("1");

    const absoluteCandidate = lift(({ text, fallback }: {
      text: string;
      fallback: number;
    }) => {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) return fallback;
      return parsed;
    })({ text: valueField, fallback: currentValue });

    const percentageCandidate = lift(({ text, fallback }: {
      text: string;
      fallback: number;
    }) => {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) return fallback;
      return clampNumber(parsed, 0, 100);
    })({ text: percentageField, fallback: percentage });

    const tickCandidate = derive(ticksField, (text) => {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) return 1;
      const normalized = Math.max(1, Math.abs(Math.trunc(parsed)));
      return normalized;
    });

    const sliderChange = handler<
      { detail?: { value?: number } } | undefined,
      {
        value: Cell<number>;
        min: Cell<number>;
        max: Cell<number>;
        interactions: Cell<number>;
        history: Cell<SliderSnapshot[]>;
      }
    >((event, ctx) => {
      const raw = event?.detail?.value;
      const fallback = ctx.value.get();
      const chosen = typeof raw === "number" ? raw : fallback;
      applySliderUpdate(ctx, chosen);
    })({ value, min, max, interactions, history });

    const applyAbsolute = handler<
      unknown,
      {
        value: Cell<number>;
        min: Cell<number>;
        max: Cell<number>;
        interactions: Cell<number>;
        history: Cell<SliderSnapshot[]>;
        candidate: Cell<number>;
      }
    >((_event, { candidate, ...ctx }) => {
      applySliderUpdate(ctx, candidate.get());
    })({
      value,
      min,
      max,
      interactions,
      history,
      candidate: absoluteCandidate,
    });

    const applyPercent = handler<
      unknown,
      {
        value: Cell<number>;
        min: Cell<number>;
        max: Cell<number>;
        interactions: Cell<number>;
        history: Cell<SliderSnapshot[]>;
        candidate: Cell<number>;
      }
    >((_event, { candidate, ...ctx }) => {
      const percent = normalizePercentage(candidate.get());
      const rawMin = ctx.min.get();
      const rawMax = ctx.max.get();
      const minValue = toFiniteNumber(rawMin, 0);
      const maxCandidate = toFiniteNumber(rawMax, minValue + 100);
      const maxValue = maxCandidate > minValue ? maxCandidate : minValue + 100;
      const desired = minValue + (maxValue - minValue) * percent;
      applySliderUpdate(ctx, desired);
    })({
      value,
      min,
      max,
      interactions,
      history,
      candidate: percentageCandidate,
    });

    const nudgeForward = handler<
      unknown,
      {
        value: Cell<number>;
        min: Cell<number>;
        max: Cell<number>;
        interactions: Cell<number>;
        history: Cell<SliderSnapshot[]>;
        ticks: Cell<number>;
        step: Cell<number>;
      }
    >((_event, { ticks, step, ...ctx }) => {
      const minValue = toFiniteNumber(ctx.min.get(), 0);
      const current = toFiniteNumber(ctx.value.get(), minValue);
      const stepSizeValue = toFiniteNumber(step.get(), 1);
      const desired = current + stepSizeValue * ticks.get();
      applySliderUpdate(ctx, desired);
    })({
      value,
      min,
      max,
      interactions,
      history,
      ticks: tickCandidate,
      step: stepSize,
    });

    const nudgeBackward = handler<
      unknown,
      {
        value: Cell<number>;
        min: Cell<number>;
        max: Cell<number>;
        interactions: Cell<number>;
        history: Cell<SliderSnapshot[]>;
        ticks: Cell<number>;
        step: Cell<number>;
      }
    >((_event, { ticks, step, ...ctx }) => {
      const minValue = toFiniteNumber(ctx.min.get(), 0);
      const current = toFiniteNumber(ctx.value.get(), minValue);
      const stepSizeValue = toFiniteNumber(step.get(), 1);
      const desired = current - stepSizeValue * ticks.get();
      applySliderUpdate(ctx, desired);
    })({
      value,
      min,
      max,
      interactions,
      history,
      ticks: tickCandidate,
      step: stepSize,
    });

    const setPosition = setSliderValue({
      value,
      min,
      max,
      interactions,
      history,
    });
    const nudge = nudgeSlider({
      value,
      min,
      max,
      step,
      interactions,
      history,
    });

    const name =
      str`Range slider (${currentDisplay}/${minDisplay}-${maxDisplay})`;
    const status =
      str`Value ${currentDisplay} • ${percentageDisplay}% of span (${spanDisplay}) • ${interactionDisplay} interactions`;

    const syncValueField = compute(() => {
      const text = currentDisplay.get();
      if (valueField.get() !== text) {
        valueField.set(text);
      }
    });
    const syncPercentageField = compute(() => {
      const text = percentageDisplay.get();
      if (percentageField.get() !== text) {
        percentageField.set(text);
      }
    });

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 34rem;
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
                  Interactive range slider
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.25rem;
                    line-height: 1.4;
                    color: #0f172a;
                  ">
                  Tune values within {rangeSummary}
                </h2>
              </div>

              <div style="
                  display: grid;
                  gap: 0.75rem;
                  grid-template-columns: repeat(2, minmax(0, 1fr));
                ">
                <div style="
                    background: #f8fafc;
                    border-radius: 0.75rem;
                    padding: 0.75rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <span style="
                      font-size: 0.75rem;
                      color: #475569;
                    ">
                    Current value
                  </span>
                  <strong
                    data-testid="current-value"
                    style="font-size: 1.75rem; color: #0f172a;"
                  >
                    {currentDisplay}
                  </strong>
                  <span style="font-size: 0.8rem; color: #64748b;">
                    {percentageDisplay}% of available range
                  </span>
                </div>

                <div style="
                    background: #eef2ff;
                    border-radius: 0.75rem;
                    padding: 0.75rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <span style="
                      font-size: 0.75rem;
                      color: #4c1d95;
                    ">
                    Step size
                  </span>
                  <strong style="font-size: 1.5rem; color: #1e1b4b;">
                    {stepDisplay}
                  </strong>
                  <span style="font-size: 0.8rem; color: #64748b;">
                    Span {spanDisplay} across {interactionDisplay} moves
                  </span>
                </div>
              </div>

              <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                <label
                  for="range-slider"
                  style="font-size: 0.9rem; font-weight: 600; color: #0f172a;"
                >
                  Adjust with slider
                </label>
                <ct-slider
                  id="range-slider"
                  min={minDisplay}
                  max={maxDisplay}
                  step={stepDisplay}
                  $value={currentValue}
                  onCtChange={sliderChange}
                  aria-valuemin={minDisplay}
                  aria-valuemax={maxDisplay}
                  aria-valuenow={currentDisplay}
                >
                </ct-slider>
              </div>

              <div style="
                  display: grid;
                  grid-template-columns: repeat(
                    auto-fit,
                    minmax(12rem, 1fr)
                  );
                  gap: 0.75rem;
                ">
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.45rem;
                  ">
                  <label
                    for="absolute-value"
                    style="font-size: 0.85rem; font-weight: 500; color: #334155;"
                  >
                    Set exact value
                  </label>
                  <div style="
                      display: flex;
                      gap: 0.5rem;
                      align-items: center;
                    ">
                    <ct-input
                      id="absolute-value"
                      type="number"
                      $value={valueField}
                      aria-label="Provide an absolute slider value"
                    >
                    </ct-input>
                    <ct-button onClick={applyAbsolute}>
                      Apply
                    </ct-button>
                  </div>
                  <span style="font-size: 0.75rem; color: #64748b;">
                    Values outside the range snap to the nearest edge.
                  </span>
                </div>

                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.45rem;
                  ">
                  <label
                    for="percentage-value"
                    style="font-size: 0.85rem; font-weight: 500; color: #334155;"
                  >
                    Set by percentage
                  </label>
                  <div style="
                      display: flex;
                      gap: 0.5rem;
                      align-items: center;
                    ">
                    <ct-input
                      id="percentage-value"
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      $value={percentageField}
                      aria-label="Provide a percentage of the range"
                    >
                    </ct-input>
                    <ct-button onClick={applyPercent}>
                      Jump
                    </ct-button>
                  </div>
                  <span style="font-size: 0.75rem; color: #64748b;">
                    Enter 0 to 100 to seek a position in the span.
                  </span>
                </div>
              </div>

              <div style="
                  display: flex;
                  flex-wrap: wrap;
                  gap: 0.75rem;
                  align-items: flex-end;
                ">
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.45rem;
                  ">
                  <label
                    for="tick-count"
                    style="font-size: 0.85rem; font-weight: 500; color: #334155;"
                  >
                    Steps per nudge
                  </label>
                  <ct-input
                    id="tick-count"
                    type="number"
                    min="1"
                    step="1"
                    $value={ticksField}
                    aria-label="Choose how many steps to nudge"
                  >
                  </ct-input>
                </div>
                <div style="
                    display: flex;
                    gap: 0.5rem;
                    flex-wrap: wrap;
                  ">
                  <ct-button variant="secondary" onClick={nudgeBackward}>
                    Nudge back
                  </ct-button>
                  <ct-button onClick={nudgeForward}>
                    Nudge forward
                  </ct-button>
                </div>
                <span style="font-size: 0.75rem; color: #64748b;">
                  Nudges move by step × chosen count.
                </span>
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
              <h3 style="margin: 0; font-size: 1rem;">Interaction history</h3>
              <ct-badge variant="outline">{interactionDisplay} moves</ct-badge>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
              "
            >
              {historyCards}
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
      min,
      max,
      step: stepSize,
      currentValue,
      percentage,
      label,
      rangeSummary,
      interactions: interactionCount,
      history: historyView,
      currentDisplay,
      minDisplay,
      maxDisplay,
      percentageDisplay,
      stepDisplay,
      spanDisplay,
      interactionDisplay,
      historyRows,
      historyCards,
      inputs: {
        valueField,
        percentageField,
        ticksField,
        absoluteCandidate,
        percentageCandidate,
        tickCandidate,
      },
      controls: {
        setPosition,
        nudge,
        sliderChange,
        applyAbsolute,
        applyPercent,
        nudgeForward,
        nudgeBackward,
      },
      status,
      effects: {
        syncValueField,
        syncPercentageField,
      },
    };
  },
);

export default counterRangeSliderUx;
