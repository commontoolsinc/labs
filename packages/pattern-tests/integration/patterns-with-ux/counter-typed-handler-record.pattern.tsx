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

type HandlerKey = "increment" | "decrement" | "setExact";

interface TypedHandlerRecordArgs {
  value: Default<number, 0>;
  step: Default<number, 1>;
}

interface CounterChange {
  action: HandlerKey | "init";
  previous: number;
  next: number;
}

type HandlerInvocationCounts = Record<HandlerKey, number>;

interface HandlerDescriptor {
  key: HandlerKey;
  label: string;
  calls: number;
}

const sanitizeNumber = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.round(value * 100) / 100;
  return Number.isFinite(rounded) ? rounded : fallback;
};

const sanitizeCount = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  const integer = Math.trunc(value);
  return integer >= 0 ? integer : 0;
};

const sanitizeCounts = (
  record: HandlerInvocationCounts | undefined,
): HandlerInvocationCounts => {
  const typed = record ?? {
    increment: 0,
    decrement: 0,
    setExact: 0,
  };
  return {
    increment: sanitizeCount(typed.increment),
    decrement: sanitizeCount(typed.decrement),
    setExact: sanitizeCount(typed.setExact),
  };
};

const sanitizeChange = (value: CounterChange | undefined): CounterChange => {
  if (!value) {
    return { action: "init", previous: 0, next: 0 };
  }
  const action: HandlerKey | "init" = value.action === "increment" ||
      value.action === "decrement" || value.action === "setExact"
    ? value.action
    : "init";
  return {
    action,
    previous: sanitizeNumber(value.previous, 0),
    next: sanitizeNumber(value.next, 0),
  };
};

const sanitizeHistory = (
  entries: CounterChange[] | undefined,
): CounterChange[] => {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.map((entry) => sanitizeChange(entry));
};

const normalizeStep = (value: unknown): number => {
  const next = Math.abs(sanitizeNumber(value, 1));
  return next > 0 ? next : 1;
};

const recordInvocation = (
  action: HandlerKey,
  change: { previous: number; next: number },
  context: {
    history: Cell<CounterChange[]>;
    lastChange: Cell<CounterChange>;
    counts: Cell<HandlerInvocationCounts>;
    snapshotId: Cell<number>;
  },
) => {
  const entry: CounterChange = {
    action,
    previous: sanitizeNumber(change.previous, 0),
    next: sanitizeNumber(change.next, 0),
  };

  const history = context.history.get();
  const list = Array.isArray(history) ? [...history, entry] : [entry];

  context.history.set(list);
  context.lastChange.set(entry);

  const currentCounts = sanitizeCounts(context.counts.get());
  context.counts.set({
    ...currentCounts,
    [action]: currentCounts[action] + 1,
  });

  const idSeed = sanitizeCount(context.snapshotId.get());
  const nextSeed = idSeed + 1;
  context.snapshotId.set(nextSeed);
};

const incrementCounter = handler(
  (
    event: { amount?: number } | undefined,
    context: {
      value: Cell<number>;
      step: Cell<number>;
      history: Cell<CounterChange[]>;
      lastChange: Cell<CounterChange>;
      counts: Cell<HandlerInvocationCounts>;
      snapshotId: Cell<number>;
    },
  ) => {
    const previous = sanitizeNumber(context.value.get(), 0);
    const baseStep = normalizeStep(context.step.get());
    const requested = sanitizeNumber(event?.amount, baseStep);
    const amount = requested === 0 ? baseStep : Math.abs(requested);
    const next = previous + amount;

    context.value.set(next);
    recordInvocation("increment", { previous, next }, context);
  },
);

const decrementCounter = handler(
  (
    event: { amount?: number } | undefined,
    context: {
      value: Cell<number>;
      step: Cell<number>;
      history: Cell<CounterChange[]>;
      lastChange: Cell<CounterChange>;
      counts: Cell<HandlerInvocationCounts>;
      snapshotId: Cell<number>;
    },
  ) => {
    const previous = sanitizeNumber(context.value.get(), 0);
    const baseStep = normalizeStep(context.step.get());
    const requested = sanitizeNumber(event?.amount, baseStep);
    const amount = requested === 0 ? baseStep : Math.abs(requested);
    const next = previous - amount;

    context.value.set(next);
    recordInvocation("decrement", { previous, next }, context);
  },
);

const setExactCounter = handler(
  (
    event: { value?: number } | undefined,
    context: {
      value: Cell<number>;
      history: Cell<CounterChange[]>;
      lastChange: Cell<CounterChange>;
      counts: Cell<HandlerInvocationCounts>;
      snapshotId: Cell<number>;
    },
  ) => {
    const previous = sanitizeNumber(context.value.get(), 0);
    const next = typeof event?.value === "number"
      ? sanitizeNumber(event.value, previous)
      : previous;

    context.value.set(next);
    recordInvocation("setExact", { previous, next }, context);
  },
);

const uiSetExactCounter = handler(
  (
    _event: undefined,
    context: {
      value: Cell<number>;
      exactInputField: Cell<string>;
      history: Cell<CounterChange[]>;
      lastChange: Cell<CounterChange>;
      counts: Cell<HandlerInvocationCounts>;
      snapshotId: Cell<number>;
    },
  ) => {
    const rawInput = context.exactInputField.get();
    const inputString = typeof rawInput === "string" ? rawInput.trim() : "";
    const parsed = parseFloat(inputString);

    if (inputString === "" || !Number.isFinite(parsed)) {
      return;
    }

    const previous = sanitizeNumber(context.value.get(), 0);
    const next = sanitizeNumber(parsed, previous);

    context.value.set(next);
    recordInvocation("setExact", { previous, next }, context);
    context.exactInputField.set("");
  },
);

type CounterHandlerRecord = {
  increment: ReturnType<typeof incrementCounter>;
  decrement: ReturnType<typeof decrementCounter>;
  setExact: ReturnType<typeof setExactCounter>;
};

export const counterWithTypedHandlerRecordUx = recipe<TypedHandlerRecordArgs>(
  "Counter With Typed Handler Record (UX)",
  ({ value, step }) => {
    const history = cell<CounterChange[]>([]);
    const lastChange = cell<CounterChange>({
      action: "init",
      previous: 0,
      next: 0,
    });
    const counts = cell<HandlerInvocationCounts>({
      increment: 0,
      decrement: 0,
      setExact: 0,
    });
    const snapshotId = cell(0);
    const exactInputField = cell("");
    const sanitizedStep = lift((s: number) => normalizeStep(s))(step);

    const currentValue = lift((v: number | undefined) => sanitizeNumber(v, 0))(
      value,
    );
    const stepValue = lift((s: number) => normalizeStep(s))(sanitizedStep);
    const countsView = lift((c: HandlerInvocationCounts | undefined) =>
      sanitizeCounts(c)
    )(counts);
    const historyView = lift((h: CounterChange[] | undefined) =>
      sanitizeHistory(h)
    )(history);
    const lastChangeView = lift((lc: CounterChange | undefined) =>
      sanitizeChange(lc)
    )(lastChange);

    const totalOperations = lift((c: HandlerInvocationCounts) =>
      c.increment + c.decrement + c.setExact
    )(countsView);

    const name =
      str`Typed Handler Record: ${currentValue} (${totalOperations} ops)`;

    const handlers: CounterHandlerRecord = {
      increment: incrementCounter({
        value,
        step: sanitizedStep,
        history,
        lastChange,
        counts,
        snapshotId,
      }),
      decrement: decrementCounter({
        value,
        step: sanitizedStep,
        history,
        lastChange,
        counts,
        snapshotId,
      }),
      setExact: setExactCounter({
        value,
        history,
        lastChange,
        counts,
        snapshotId,
      }),
    };

    const uiSetExact = uiSetExactCounter({
      value,
      exactInputField,
      history,
      lastChange,
      counts,
      snapshotId,
    });

    const historyElements = lift((entries: CounterChange[]) => {
      if (!Array.isArray(entries) || entries.length === 0) {
        return (
          <div style="
              color: #94a3b8;
              font-size: 0.85rem;
              text-align: center;
              padding: 1rem;
            ">
            No operations yet
          </div>
        );
      }

      const recent = entries.slice(-5).reverse();
      const elements = [];

      for (const entry of recent) {
        const actionColor = entry.action === "increment"
          ? "#10b981"
          : entry.action === "decrement"
          ? "#f59e0b"
          : "#6366f1";

        const actionBg = entry.action === "increment"
          ? "#d1fae5"
          : entry.action === "decrement"
          ? "#fef3c7"
          : "#e0e7ff";

        const styleString =
          "display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem; background: #f8fafc; border-radius: 0.5rem; border-left: 4px solid " +
          actionColor + ";";

        const badgeStyle = "background: " + actionBg + "; color: " +
          actionColor +
          "; padding: 0.25rem 0.5rem; border-radius: 0.375rem; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em;";

        elements.push(
          <div style={styleString} key={entry.action + entry.next}>
            <span style={badgeStyle}>
              {entry.action}
            </span>
            <span style="
                font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace;
                font-size: 0.85rem;
                color: #475569;
              ">
              {String(entry.previous)} → {String(entry.next)}
            </span>
          </div>,
        );
      }

      return (
        <div style="display: flex; flex-direction: column; gap: 0.5rem;">
          {elements}
        </div>
      );
    })(historyView);

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
                  Typed Handler Record Demo
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Counter with typed handler collection
                </h2>
                <p style="
                    margin: 0;
                    font-size: 0.9rem;
                    color: #64748b;
                  ">
                  Demonstrates organizing handlers in a typed record, tracking
                  invocation counts per handler, and maintaining a typed change
                  history
                </p>
              </div>

              <div style="
                  background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
                  border: 2px solid #cbd5e1;
                  border-radius: 0.75rem;
                  padding: 1.5rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                  align-items: center;
                ">
                <span style="
                    color: #475569;
                    font-size: 0.7rem;
                    letter-spacing: 0.05em;
                    text-transform: uppercase;
                  ">
                  Current Value
                </span>
                <div style="
                    font-size: 3.5rem;
                    font-weight: 700;
                    color: #0f172a;
                    font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace;
                  ">
                  {currentValue}
                </div>
              </div>

              <div style="
                  display: grid;
                  grid-template-columns: repeat(3, 1fr);
                  gap: 0.75rem;
                ">
                <div style="
                    background: #d1fae5;
                    border: 2px solid #10b981;
                    border-radius: 0.5rem;
                    padding: 0.875rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.375rem;
                    align-items: center;
                  ">
                  <span style="
                      color: #047857;
                      font-size: 0.65rem;
                      letter-spacing: 0.05em;
                      text-transform: uppercase;
                      font-weight: 600;
                    ">
                    Increments
                  </span>
                  <div style="
                      font-size: 1.75rem;
                      font-weight: 700;
                      color: #065f46;
                      font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace;
                    ">
                    {lift((c: HandlerInvocationCounts) => String(c.increment))(
                      countsView,
                    )}
                  </div>
                </div>

                <div style="
                    background: #fef3c7;
                    border: 2px solid #f59e0b;
                    border-radius: 0.5rem;
                    padding: 0.875rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.375rem;
                    align-items: center;
                  ">
                  <span style="
                      color: #b45309;
                      font-size: 0.65rem;
                      letter-spacing: 0.05em;
                      text-transform: uppercase;
                      font-weight: 600;
                    ">
                    Decrements
                  </span>
                  <div style="
                      font-size: 1.75rem;
                      font-weight: 700;
                      color: #92400e;
                      font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace;
                    ">
                    {lift((c: HandlerInvocationCounts) => String(c.decrement))(
                      countsView,
                    )}
                  </div>
                </div>

                <div style="
                    background: #e0e7ff;
                    border: 2px solid #6366f1;
                    border-radius: 0.5rem;
                    padding: 0.875rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.375rem;
                    align-items: center;
                  ">
                  <span style="
                      color: #4338ca;
                      font-size: 0.65rem;
                      letter-spacing: 0.05em;
                      text-transform: uppercase;
                      font-weight: 600;
                    ">
                    Set Exact
                  </span>
                  <div style="
                      font-size: 1.75rem;
                      font-weight: 700;
                      color: #3730a3;
                      font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace;
                    ">
                    {lift((c: HandlerInvocationCounts) => String(c.setExact))(
                      countsView,
                    )}
                  </div>
                </div>
              </div>

              <div style="
                  display: flex;
                  gap: 0.75rem;
                ">
                <ct-button
                  onClick={handlers.increment}
                  style="flex: 1;"
                  aria-label="Increment counter"
                >
                  +{stepValue} Increment
                </ct-button>
                <ct-button
                  onClick={handlers.decrement}
                  style="flex: 1;"
                  aria-label="Decrement counter"
                >
                  −{stepValue} Decrement
                </ct-button>
              </div>

              <div style="
                  background: #f8fafc;
                  border: 2px solid #cbd5e1;
                  border-radius: 0.5rem;
                  padding: 1rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
                <span style="
                    color: #475569;
                    font-size: 0.75rem;
                    letter-spacing: 0.05em;
                    text-transform: uppercase;
                    font-weight: 600;
                  ">
                  Set Exact Value
                </span>
                <div style="
                    display: flex;
                    gap: 0.5rem;
                  ">
                  <ct-input
                    $value={exactInputField}
                    placeholder="Enter number..."
                    style="flex: 1;"
                    aria-label="Exact value input"
                  />
                  <ct-button
                    onClick={uiSetExact}
                    aria-label="Set exact value"
                  >
                    Set
                  </ct-button>
                </div>
              </div>

              <div style="
                  background: #f8fafc;
                  border: 2px solid #cbd5e1;
                  border-radius: 0.5rem;
                  padding: 1rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
                <div style="
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                  ">
                  <span style="
                      color: #475569;
                      font-size: 0.75rem;
                      letter-spacing: 0.05em;
                      text-transform: uppercase;
                      font-weight: 600;
                    ">
                    Recent History
                  </span>
                  <span style="
                      color: #64748b;
                      font-size: 0.75rem;
                      font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace;
                    ">
                    Last 5 operations
                  </span>
                </div>
                {historyElements}
              </div>

              <div style="
                  background: #fef3c7;
                  border: 1px solid #fbbf24;
                  border-radius: 0.5rem;
                  padding: 0.875rem;
                  font-size: 0.8rem;
                  color: #92400e;
                  line-height: 1.5;
                ">
                <strong>Pattern:</strong>{" "}
                Handlers are organized in a typed record
                <code style="
                    background: #fef9e7;
                    padding: 0.125rem 0.375rem;
                    border-radius: 0.25rem;
                    font-size: 0.75rem;
                  ">
                  CounterHandlerRecord
                </code>{" "}
                with keys "increment", "decrement", and "setExact". Each
                invocation is tracked with typed metadata
                <code style="
                    background: #fef9e7;
                    padding: 0.125rem 0.375rem;
                    border-radius: 0.25rem;
                    font-size: 0.75rem;
                  ">
                  CounterChange
                </code>{" "}
                showing the action, previous value, and next value.
              </div>
            </div>
          </ct-card>
        </div>
      ),
      value,
      step: sanitizedStep,
      currentValue,
      stepValue,
      lastChange: lastChangeView,
      history: historyView,
      counts: countsView,
      handlers,
    };
  },
);

export default counterWithTypedHandlerRecordUx;
