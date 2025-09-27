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

interface DelayedCounterArgs {
  value: Default<number, 0>;
  pending: Default<number[], []>;
}

const formatNumber = (value: number) => {
  const safe = Number.isFinite(value) ? value : 0;
  const rounded = Math.round(safe * 100) / 100;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(2);
};

const enqueueAmount = (pending: Cell<number[]>, amount: number) => {
  const next = Number.isFinite(amount) ? amount : 0;
  const current = pending.get();
  const queue = Array.isArray(current)
    ? current.filter((entry) => Number.isFinite(entry))
    : [];
  pending.set([...queue, next]);
};

const scheduleIncrement = handler(
  (
    event: { amount?: number } | undefined,
    context: { pending: Cell<number[]> },
  ) => {
    const amount =
      typeof event?.amount === "number" && Number.isFinite(event.amount)
        ? event.amount
        : 1;
    enqueueAmount(context.pending, amount);
  },
);

const createPresetQueue = (amount: number) =>
  handler<unknown, { pending: Cell<number[]> }>((_event, { pending }) => {
    enqueueAmount(pending, amount);
  });

const queueCustomAmount = handler<
  unknown,
  {
    pending: Cell<number[]>;
    amount: Cell<number>;
    field: Cell<string>;
  }
>((_event, { pending, amount, field }) => {
  const value = amount.get();
  const sanitized = Number.isFinite(value) ? value : 0;
  enqueueAmount(pending, sanitized);
  field.set(formatNumber(sanitized));
});

const runDrain = handler<unknown, { drain: Cell<number> }>(
  (_event, { drain }) => {
    drain.get();
  },
);

export const counterDelayedComputeUx = recipe<DelayedCounterArgs>(
  "Counter With Delayed Compute (UX)",
  ({ value, pending }) => {
    const ensureDefaults = compute(() => {
      const stored = value.get();
      if (typeof stored !== "number" || !Number.isFinite(stored)) {
        value.set(0);
      }
      const queue = pending.get();
      if (!Array.isArray(queue)) {
        pending.set([]);
        return;
      }
      const sanitized = queue.filter((entry) => Number.isFinite(entry));
      if (sanitized.length !== queue.length) {
        pending.set(sanitized);
      }
    });

    const drainPending = compute(() => {
      const queuedRaw = pending.get();
      const entries = Array.isArray(queuedRaw)
        ? queuedRaw.filter((entry) => Number.isFinite(entry))
        : [];
      const stored = value.get();
      const base = typeof stored === "number" && Number.isFinite(stored)
        ? stored
        : 0;
      if (entries.length === 0) {
        if (!Number.isFinite(stored)) value.set(base);
        return base;
      }

      const total = entries.reduce((sum, item) => sum + item, 0);
      pending.set([]);
      const next = base + total;
      value.set(next);
      return next;
    });

    const storedValue = derive(
      value,
      (current) =>
        typeof current === "number" && Number.isFinite(current) ? current : 0,
    );
    const queueEntries = derive(
      pending,
      (entries) =>
        Array.isArray(entries)
          ? entries.filter((entry) => Number.isFinite(entry))
          : [],
    );
    const queueCount = derive(queueEntries, (entries) => entries.length);
    const queueTotal = derive(
      queueEntries,
      (entries) => entries.reduce((sum, item) => sum + item, 0),
    );

    const previewValue = lift(({ current, queued }) => current + queued)({
      current: storedValue,
      queued: queueTotal,
    });

    const storedDisplay = derive(storedValue, (next) => formatNumber(next));
    const previewDisplay = derive(previewValue, (next) => formatNumber(next));
    const totalDisplay = derive(queueTotal, (next) => formatNumber(next));

    const pendingBadges = lift((entries: number[]) =>
      entries.length === 0
        ? [
          <span style="
              display: inline-flex;
              padding: 0.25rem 0.5rem;
              border-radius: 999px;
              background: #e2e8f0;
              color: #475569;
              font-size: 0.75rem;
            ">
            No increments queued
          </span>,
        ]
        : entries.map((amount, index) => (
          <span
            data-testid={`pending-entry-${index}`}
            style="
              display: inline-flex;
              padding: 0.25rem 0.5rem;
              border-radius: 999px;
              background: #e0f2fe;
              color: #0369a1;
              font-size: 0.75rem;
              font-weight: 500;
            "
          >
            {formatNumber(amount)}
          </span>
        ))
    )(queueEntries);

    const amountField = cell("1");
    const amountValue = lift(({ raw }: { raw: string }) => {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return 1;
      const limited = Math.max(Math.min(parsed, 9999), -9999);
      return Math.round(limited * 100) / 100;
    })({ raw: amountField });
    const amountDisplay = derive(amountValue, (value) => formatNumber(value));

    const scheduleOne = createPresetQueue(1)({ pending });
    const scheduleFive = createPresetQueue(5)({ pending });
    const scheduleMinusTwo = createPresetQueue(-2)({ pending });
    const scheduleCustom = queueCustomAmount({
      pending,
      amount: amountValue,
      field: amountField,
    });
    const applyQueue = runDrain({ drain: drainPending });

    const name = str`Delayed compute (${storedDisplay})`;
    const status =
      str`Stored ${storedDisplay} • ${queueCount} queued → ${previewDisplay}`;

    const schedule = scheduleIncrement({ pending });

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 28rem;
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
                  gap: 0.5rem;
                ">
                <span style="
                    font-size: 0.75rem;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                    color: #475569;
                  ">
                  Counter state
                </span>
                <div style="
                    display: grid;
                    gap: 0.75rem;
                    grid-template-columns: repeat(2, minmax(0, 1fr));
                  ">
                  <div style="
                      background: #f1f5f9;
                      border-radius: 0.75rem;
                      padding: 0.75rem;
                    ">
                    <span style="
                        display: block;
                        font-size: 0.75rem;
                        color: #475569;
                      ">
                      Last computed value
                    </span>
                    <strong
                      data-testid="computed-value"
                      style="
                        display: block;
                        font-size: 1.75rem;
                      "
                    >
                      {storedDisplay}
                    </strong>
                  </div>
                  <div style="
                      background: #e2e8f0;
                      border-radius: 0.75rem;
                      padding: 0.75rem;
                    ">
                    <span style="
                        display: block;
                        font-size: 0.75rem;
                        color: #475569;
                      ">
                      After next compute
                    </span>
                    <strong
                      data-testid="preview-value"
                      style="
                        display: block;
                        font-size: 1.75rem;
                      "
                    >
                      {previewDisplay}
                    </strong>
                  </div>
                </div>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                ">
                <span style="
                    font-size: 0.85rem;
                    font-weight: 500;
                    color: #334155;
                  ">
                  Pending increments
                </span>
                <div
                  data-testid="pending-badges"
                  style="
                    display: flex;
                    flex-wrap: wrap;
                    gap: 0.5rem;
                  "
                >
                  {pendingBadges}
                </div>
                <div style="
                    display: flex;
                    gap: 0.75rem;
                    flex-wrap: wrap;
                  ">
                  <div style="
                      display: flex;
                      flex-direction: column;
                      min-width: 8rem;
                    ">
                    <span style="
                        font-size: 0.75rem;
                        color: #64748b;
                      ">
                      Total queued
                    </span>
                    <strong
                      data-testid="queued-total"
                      style="
                        font-size: 1.1rem;
                      "
                    >
                      {totalDisplay}
                    </strong>
                  </div>
                  <div style="
                      display: flex;
                      flex-direction: column;
                      min-width: 8rem;
                    ">
                    <span style="
                        font-size: 0.75rem;
                        color: #64748b;
                      ">
                      Items queued
                    </span>
                    <strong
                      data-testid="queued-count"
                      style="
                        font-size: 1.1rem;
                      "
                    >
                      {queueCount}
                    </strong>
                  </div>
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
                gap: 1rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                ">
                <span style="
                    font-size: 0.85rem;
                    font-weight: 500;
                    color: #334155;
                  ">
                  Add increments
                </span>
                <div style="
                    display: flex;
                    gap: 0.5rem;
                    flex-wrap: wrap;
                  ">
                  <ct-button data-testid="schedule-one" onClick={scheduleOne}>
                    +1
                  </ct-button>
                  <ct-button data-testid="schedule-five" onClick={scheduleFive}>
                    +5
                  </ct-button>
                  <ct-button
                    data-testid="schedule-minus-two"
                    variant="secondary"
                    onClick={scheduleMinusTwo}
                  >
                    -2
                  </ct-button>
                </div>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                ">
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
                    gap: 0.5rem;
                    flex-wrap: wrap;
                    align-items: center;
                  ">
                  <ct-input
                    id="custom-amount"
                    type="number"
                    step="1"
                    $value={amountField}
                    min="-9999"
                    max="9999"
                    aria-label="Amount to schedule"
                    style="max-width: 8rem;"
                  >
                  </ct-input>
                  <ct-button
                    data-testid="schedule-custom"
                    variant="primary"
                    onClick={scheduleCustom}
                  >
                    Queue {amountDisplay}
                  </ct-button>
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
                  flex-direction: column;
                  gap: 0.25rem;
                ">
                <span style="
                    font-size: 0.75rem;
                    color: #64748b;
                    text-transform: uppercase;
                    letter-spacing: 0.08em;
                  ">
                  Compute cycle
                </span>
                <p style="
                    margin: 0;
                    font-size: 0.95rem;
                    color: #475569;
                  ">
                  Schedule increments first, then run a compute cycle to apply
                  them to the counter.
                </p>
              </div>
              <ct-button
                data-testid="process-queue"
                variant="primary"
                onClick={applyQueue}
              >
                Run compute cycle
              </ct-button>
              <div
                role="status"
                aria-live="polite"
                data-testid="status"
                style="
                  font-size: 0.9rem;
                  color: #334155;
                "
              >
                {status}
              </div>
            </div>
          </ct-card>
        </div>
      ),
      value: drainPending,
      schedule,
      rawValue: value,
      pending,
      effects: { ensureDefaults },
      controls: {
        scheduleOne,
        scheduleFive,
        scheduleMinusTwo,
        scheduleCustom,
        applyQueue,
      },
      metrics: {
        queueCount,
        queueTotal,
        storedValue,
        previewValue,
      },
    };
  },
);

export default counterDelayedComputeUx;
