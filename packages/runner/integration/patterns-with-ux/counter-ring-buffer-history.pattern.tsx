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

interface RingBufferCounterArgs {
  value: Default<number, 0>;
  history: Default<number[], []>;
  capacity: Default<number, 3>;
}

type RingBufferContext = {
  value: Cell<number>;
  history: Cell<number[]>;
  limit: Cell<number>;
};

const normalizeCapacityValue = (raw: unknown): number => {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 3;
  }
  const normalized = Math.floor(raw);
  return normalized > 0 ? normalized : 1;
};

const applyDelta = (delta: number, context: RingBufferContext) => {
  const amount = Number.isFinite(delta) ? delta : 0;
  const current = context.value.get();
  const base = typeof current === "number" ? current : 0;
  const next = base + amount;
  context.value.set(next);

  const capacity = normalizeCapacityValue(context.limit.get());
  const existing = context.history.get();
  const list = Array.isArray(existing) ? existing : [];
  const trimmed = [...list.slice(-Math.max(capacity - 1, 0)), next];
  context.history.set(trimmed);
};

const incrementAndTrim = handler(
  (
    event: { amount?: number } | undefined,
    context: RingBufferContext,
  ) => {
    const delta = typeof event?.amount === "number" ? event.amount : 1;
    applyDelta(delta, context);
  },
);

const adjustBy = (delta: number) =>
  handler<unknown, RingBufferContext>((_event, context) => {
    applyDelta(delta, context);
  });

const resizeBuffer = handler(
  (
    event: { capacity?: number } | undefined,
    context: { capacity: Cell<number>; history: Cell<number[]> },
  ) => {
    if (
      typeof event?.capacity !== "number" ||
      !Number.isFinite(event.capacity)
    ) {
      return;
    }
    const nextCapacity = normalizeCapacityValue(event.capacity);
    context.capacity.set(nextCapacity);

    const existing = context.history.get();
    const list = Array.isArray(existing) ? existing : [];
    context.history.set(list.slice(-nextCapacity));
  },
);

const formatNumber = (value: number): string => {
  if (!Number.isFinite(value)) {
    return "0";
  }
  const fixed = Math.round(value * 100) / 100;
  return Number.isInteger(fixed) ? `${fixed}` : fixed.toFixed(2);
};

const formatSigned = (value: number): string => {
  const display = formatNumber(value);
  return value > 0 ? `+${display}` : `${display}`;
};

export const counterRingBufferHistoryUx = recipe<RingBufferCounterArgs>(
  "Counter With Ring Buffer History (UX)",
  ({ value, history, capacity }) => {
    const currentValue = lift((count: number | undefined) =>
      typeof count === "number" ? count : 0
    )(value);

    const historyView = lift((entries: number[] | undefined) =>
      Array.isArray(entries) ? entries : []
    )(history);

    const limit = lift((raw: number | undefined) =>
      normalizeCapacityValue(raw)
    )(capacity);

    const label = str`Value ${currentValue} | limit ${limit}`;

    const historyWithMetadata = derive(
      historyView,
      (entries) =>
        entries.map((entry, index) => ({
          id: `${index}-${entry}`,
          value: entry,
          label: formatNumber(entry),
        })),
    );

    const currentDisplay = derive(
      currentValue,
      (value) => formatNumber(value),
    );

    const metricsTitle = lift(({ count, cap }: {
      count: number;
      cap: number;
    }) => {
      return `Latest total ${formatNumber(count)} (capacity ${cap})`;
    })({ count: currentValue, cap: limit });

    const historyBadges = lift((items: {
      items: { id: string; label: string }[];
    }) => {
      if (items.items.length === 0) {
        return [
          <span
            key="empty"
            style="color: #64748b; font-size: 0.85rem;"
          >
            No history yet. Use the controls to record the first reading.
          </span>,
        ];
      }
      return items.items.map((entry) => (
        <ct-badge
          key={entry.id}
          variant="subtle"
        >
          {entry.label}
        </ct-badge>
      ));
    })({ items: historyWithMetadata });

    const amountField = cell<string>("1");
    const customAmount = derive(amountField, (raw) => {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed === 0) {
        return 1;
      }
      return Math.round(parsed * 100) / 100;
    });

    const customAmountDisplay = derive(
      customAmount,
      (value) => formatSigned(value),
    );

    const capacityField = cell<string>("3");
    const capacityCandidate = derive(capacityField, (raw) => {
      const parsed = Number(raw);
      return normalizeCapacityValue(parsed);
    });

    const syncCapacityField = compute(() => {
      const target = `${limit.get()}`;
      if (capacityField.get() !== target) {
        capacityField.set(target);
      }
    });

    const baseContext: RingBufferContext = { value, history, limit };

    const increment = incrementAndTrim(baseContext);
    const increaseOne = adjustBy(1)(baseContext);
    const increaseFive = adjustBy(5)(baseContext);
    const decreaseOne = adjustBy(-1)(baseContext);
    const decreaseFive = adjustBy(-5)(baseContext);

    const applyCustomAmount = handler<
      unknown,
      RingBufferContext & { amount: Cell<number>; field: Cell<string> }
    >((_event, context) => {
      const delta = context.amount.get();
      applyDelta(delta, context);
      context.field.set(formatNumber(delta));
    });

    const applyCustom = applyCustomAmount({
      value,
      history,
      limit,
      amount: customAmount,
      field: amountField,
    });

    const resize = resizeBuffer({ capacity, history });
    const applyCapacityChange = handler<
      unknown,
      {
        candidate: Cell<number>;
        field: Cell<string>;
        capacity: Cell<number>;
        history: Cell<number[]>;
      }
    >((_event, context) => {
      const next = normalizeCapacityValue(context.candidate.get());
      context.capacity.set(next);
      const existing = context.history.get();
      const list = Array.isArray(existing) ? existing : [];
      context.history.set(list.slice(-next));
      context.field.set(`${next}`);
    });

    const applyCapacity = applyCapacityChange({
      candidate: capacityCandidate,
      field: capacityField,
      capacity,
      history,
    });

    const name = str`Ring buffer tracker (${limit} max entries)`;

    const entryCount = derive(historyView, (items) => items.length);
    const status = lift(({ current, size, count }: {
      current: number;
      size: number;
      count: number;
    }) => {
      const total = formatNumber(current);
      const capacityText = size === 1 ? "1 slot" : `${size} slots`;
      const entryText = count === 1
        ? "1 reading stored"
        : `${count} readings stored`;
      return `${total} total • ${entryText} • ${capacityText}`;
    })({
      current: currentValue,
      size: limit,
      count: entryCount,
    });

    return {
      value,
      history,
      capacity,
      currentValue,
      historyView,
      limit,
      label,
      increment,
      resize,
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            padding: 1rem;
            max-width: 38rem;
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
                  display: flex;
                  flex-direction: column;
                  gap: 0.25rem;
                ">
                <span style="
                    font-size: 0.75rem;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                    color: #475569;
                  ">
                  Ring buffer monitor
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.35rem;
                    line-height: 1.35;
                  ">
                  {metricsTitle}
                </h2>
                <p style="
                    margin: 0;
                    color: #475569;
                    font-size: 0.95rem;
                  ">
                  Track each adjustment, keep just the latest entries, and tune
                  the buffer size without losing momentum.
                </p>
                <ct-chip
                  data-testid="status-chip"
                  variant="soft"
                >
                  {status}
                </ct-chip>
              </div>

              <div style="
                  display: grid;
                  grid-template-columns: repeat(2, minmax(0, 1fr));
                  gap: 0.75rem;
                ">
                <div style="
                    background: #f1f5f9;
                    border-radius: 0.75rem;
                    padding: 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.35rem;
                  ">
                  <span style="
                      font-size: 0.8rem;
                      color: #475569;
                      text-transform: uppercase;
                      letter-spacing: 0.04em;
                    ">
                    Current total
                  </span>
                  <strong
                    data-testid="current-total"
                    style="
                      font-size: 2rem;
                      line-height: 1;
                    "
                  >
                    {currentDisplay}
                  </strong>
                </div>
                <div style="
                    background: #e2e8f0;
                    border-radius: 0.75rem;
                    padding: 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.35rem;
                  ">
                  <span style="
                      font-size: 0.8rem;
                      color: #475569;
                      text-transform: uppercase;
                      letter-spacing: 0.04em;
                    ">
                    Capacity
                  </span>
                  <strong
                    data-testid="capacity-value"
                    style="
                      font-size: 2rem;
                      line-height: 1;
                    "
                  >
                    {limit}
                  </strong>
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
                gap: 1.25rem;
              "
            >
              <section
                aria-label="Quick adjustments"
                style="
                  display: flex;
                  flex-wrap: wrap;
                  gap: 0.5rem;
                "
              >
                <ct-button
                  data-testid="increase-one"
                  onClick={increaseOne}
                >
                  +1
                </ct-button>
                <ct-button
                  data-testid="increase-five"
                  onClick={increaseFive}
                  variant="secondary"
                >
                  +5
                </ct-button>
                <ct-button
                  data-testid="decrease-one"
                  onClick={decreaseOne}
                  variant="ghost"
                >
                  -1
                </ct-button>
                <ct-button
                  data-testid="decrease-five"
                  onClick={decreaseFive}
                  variant="ghost"
                >
                  -5
                </ct-button>
              </section>

              <section
                aria-label="Custom adjustment"
                style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                "
              >
                <label
                  for="custom-amount"
                  style="
                    font-size: 0.85rem;
                    font-weight: 500;
                    color: #334155;
                  "
                >
                  Custom amount
                </label>
                <div style="
                    display: flex;
                    flex-wrap: wrap;
                    gap: 0.5rem;
                    align-items: center;
                  ">
                  <ct-input
                    id="custom-amount"
                    type="number"
                    step="0.1"
                    $value={amountField}
                    aria-label="Set custom amount"
                  >
                  </ct-input>
                  <ct-button
                    data-testid="apply-custom"
                    onClick={applyCustom}
                  >
                    Apply {customAmountDisplay}
                  </ct-button>
                </div>
              </section>

              <section
                aria-label="Capacity controls"
                style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                "
              >
                <label
                  for="capacity-input"
                  style="
                    font-size: 0.85rem;
                    font-weight: 500;
                    color: #334155;
                  "
                >
                  Buffer size
                </label>
                <div style="
                    display: flex;
                    flex-wrap: wrap;
                    gap: 0.5rem;
                    align-items: center;
                  ">
                  <ct-input
                    id="capacity-input"
                    type="number"
                    min="1"
                    step="1"
                    $value={capacityField}
                    aria-label="Set buffer capacity"
                  >
                  </ct-input>
                  <ct-button
                    data-testid="apply-capacity"
                    onClick={applyCapacity}
                    variant="secondary"
                  >
                    Update capacity
                  </ct-button>
                </div>
              </section>
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
                  flex-direction: column;
                  gap: 0.25rem;
                ">
                <h3 style="
                    margin: 0;
                    font-size: 1.05rem;
                  ">
                  Ring buffer history
                </h3>
                <span style="
                    color: #475569;
                    font-size: 0.85rem;
                  ">
                  The buffer keeps the most recent {limit}{" "}
                  totals. Earlier entries drop off once the capacity is reached.
                </span>
              </div>
              <div
                data-testid="history-list"
                style="
                  display: flex;
                  flex-wrap: wrap;
                  gap: 0.5rem;
                "
              >
                {historyBadges}
              </div>
            </div>
          </ct-card>
        </div>
      ),
    };
  },
);
