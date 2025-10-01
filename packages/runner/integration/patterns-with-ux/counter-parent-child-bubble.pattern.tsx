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
  type Stream,
  UI,
} from "commontools";

interface ParentChildBubbleArgs {
  parent: Default<number, 0>;
  child: Default<number, 0>;
}

type BubbleEvent = {
  amount?: unknown;
  via?: unknown;
};

type BubbleRecord = {
  amount: number;
  via: string;
};

const asIncrementStream = (
  ref: unknown,
): Stream<{ amount?: number }> => ref as Stream<{ amount?: number }>;

const sanitizeAmount = (value: unknown): number => {
  return typeof value === "number" && Number.isFinite(value) ? value : 1;
};

const sanitizeVia = (value: unknown): string => {
  return typeof value === "string" && value.length > 0 ? value : "parent";
};

const childIncrement = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = sanitizeAmount(event?.amount);
    const current = context.value.get() ?? 0;
    context.value.set(current + amount);
  },
);

const childCounter = recipe<{ value: Default<number, 0> }>(
  "Bubbled Child Counter",
  ({ value }) => {
    const safeValue = lift((count: number | undefined) =>
      typeof count === "number" && Number.isFinite(count) ? count : 0
    )(value);
    return {
      value,
      label: str`Child count ${safeValue}`,
      increment: childIncrement({ value }),
    };
  },
);

const bubbleToChild = handler(
  (
    event: BubbleEvent | undefined,
    context: {
      childIncrement: Stream<{ amount?: number }>;
      parent: Cell<number>;
      history: Cell<BubbleRecord[]>;
      forwardedCount: Cell<number>;
    },
  ) => {
    const amount = sanitizeAmount(event?.amount);
    const via = sanitizeVia(event?.via);

    const parentCurrent = context.parent.get() ?? 0;
    context.parent.set(parentCurrent + amount);

    const existingHistory = context.history.get();
    const history = Array.isArray(existingHistory)
      ? existingHistory.slice()
      : [];
    history.push({ amount, via });
    context.history.set(history);

    const forwarded = context.forwardedCount.get() ?? 0;
    context.forwardedCount.set(forwarded + 1);

    context.childIncrement.send({ amount });
  },
);

const parentIncrement = handler(
  (
    event: { amount?: number } | undefined,
    context: { parent: Cell<number> },
  ) => {
    const amount = sanitizeAmount(event?.amount);
    const parentCurrent = context.parent.get() ?? 0;
    context.parent.set(parentCurrent + amount);
  },
);

/** Pattern with UX demonstrating parent-child event bubbling. */
export const counterWithParentChildBubblingUx = recipe<ParentChildBubbleArgs>(
  "Counter With Parent-Child Event Bubbling (UX)",
  ({ parent, child }) => {
    const parentView = lift((count: number | undefined) =>
      typeof count === "number" && Number.isFinite(count) ? count : 0
    )(parent);

    const forwardedCount = cell(0);
    const history = cell<BubbleRecord[]>([]);

    const forwardedView = lift((count: number | undefined) =>
      typeof count === "number" && Number.isFinite(count) ? count : 0
    )(forwardedCount);

    const historyView = lift((records: BubbleRecord[] | undefined) =>
      Array.isArray(records) ? records : []
    )(history);

    const childState = childCounter({ value: child });

    const childView = lift((count: number | undefined) =>
      typeof count === "number" && Number.isFinite(count) ? count : 0
    )(childState.key("value"));

    const bubbleAmount = cell<string>("1");

    const performBubble = handler<
      unknown,
      {
        childIncrement: Stream<{ amount?: number }>;
        parent: Cell<number>;
        history: Cell<BubbleRecord[]>;
        forwardedCount: Cell<number>;
        bubbleAmount: Cell<string>;
      }
    >((
      _event,
      { childIncrement, parent, history, forwardedCount, bubbleAmount },
    ) => {
      const amountStr = bubbleAmount.get() ?? "1";
      const amount = parseInt(amountStr, 10);
      const sanitized = sanitizeAmount(amount);

      const parentCurrent = parent.get() ?? 0;
      parent.set(parentCurrent + sanitized);

      const existingHistory = history.get();
      const historyArray = Array.isArray(existingHistory)
        ? existingHistory.slice()
        : [];
      historyArray.push({ amount: sanitized, via: "bubble" });
      history.set(historyArray);

      const forwarded = forwardedCount.get() ?? 0;
      forwardedCount.set(forwarded + 1);

      childIncrement.send({ amount: sanitized });
    })({
      childIncrement: asIncrementStream(childState.key("increment")),
      parent,
      history,
      forwardedCount,
      bubbleAmount,
    });

    const performParentIncrement = handler<
      unknown,
      { parent: Cell<number> }
    >((_event, { parent }) => {
      const amount = 1;
      const parentCurrent = parent.get() ?? 0;
      parent.set(parentCurrent + amount);
    })({ parent });

    const name = str`Event Bubbling (${forwardedView} bubbled)`;

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 48rem;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
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
                    color: #64748b;
                    font-size: 0.75rem;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                    font-weight: 600;
                  ">
                  Event Bubbling Pattern
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.5rem;
                    color: #0f172a;
                    font-weight: 700;
                  ">
                  Parent-Child Counter Cascade
                </h2>
                <p style="
                    margin: 0.5rem 0 0 0;
                    color: #64748b;
                    font-size: 0.9rem;
                    line-height: 1.5;
                  ">
                  Demonstrates event bubbling where parent handlers forward
                  increments to child streams. The "Bubble" action updates both
                  parent and child, while "Parent Only" updates just the parent
                  counter.
                </p>
              </div>

              <div style="
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  border-radius: 1rem;
                  padding: 1.5rem;
                  color: white;
                ">
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    gap: 1rem;
                  ">
                  <div style="flex: 1;">
                    <div style="
                        font-size: 0.75rem;
                        text-transform: uppercase;
                        letter-spacing: 0.1em;
                        opacity: 0.9;
                        margin-bottom: 0.5rem;
                      ">
                      Events Bubbled
                    </div>
                    <div style="
                        font-size: 3rem;
                        font-weight: 700;
                        line-height: 1;
                      ">
                      {forwardedView}
                    </div>
                  </div>
                  <div style="
                      font-size: 4rem;
                      opacity: 0.3;
                    ">
                    ↗
                  </div>
                </div>
              </div>
            </div>
          </ct-card>

          <div style="
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
              gap: 1rem;
            ">
            <ct-card>
              <div
                slot="header"
                style="
                  display: flex;
                  align-items: center;
                  gap: 0.5rem;
                "
              >
                <span style="
                    font-size: 1.5rem;
                  ">
                  👨‍👩‍👧
                </span>
                <h3 style="
                    margin: 0;
                    font-size: 1.1rem;
                    color: #0f172a;
                    font-weight: 600;
                  ">
                  Parent Counter
                </h3>
              </div>
              <div
                slot="content"
                style="
                  display: flex;
                  flex-direction: column;
                  gap: 1rem;
                "
              >
                <div style="
                    background: #f1f5f9;
                    border-radius: 0.75rem;
                    padding: 1.5rem;
                    text-align: center;
                  ">
                  <div style="
                      font-size: 0.75rem;
                      color: #64748b;
                      text-transform: uppercase;
                      letter-spacing: 0.05em;
                      margin-bottom: 0.5rem;
                    ">
                    Count
                  </div>
                  <div style="
                      font-size: 3rem;
                      font-weight: 700;
                      color: #667eea;
                      line-height: 1;
                    ">
                    {parentView}
                  </div>
                </div>

                <ct-button
                  variant="primary"
                  onclick={performParentIncrement}
                  style="width: 100%;"
                >
                  <span style="
                      display: flex;
                      align-items: center;
                      justify-content: center;
                      gap: 0.5rem;
                    ">
                    <span>Parent Only +1</span>
                  </span>
                </ct-button>
              </div>
            </ct-card>

            <ct-card>
              <div
                slot="header"
                style="
                  display: flex;
                  align-items: center;
                  gap: 0.5rem;
                "
              >
                <span style="
                    font-size: 1.5rem;
                  ">
                  👶
                </span>
                <h3 style="
                    margin: 0;
                    font-size: 1.1rem;
                    color: #0f172a;
                    font-weight: 600;
                  ">
                  Child Counter
                </h3>
              </div>
              <div
                slot="content"
                style="
                  display: flex;
                  flex-direction: column;
                  gap: 1rem;
                "
              >
                <div style="
                    background: #f1f5f9;
                    border-radius: 0.75rem;
                    padding: 1.5rem;
                    text-align: center;
                  ">
                  <div style="
                      font-size: 0.75rem;
                      color: #64748b;
                      text-transform: uppercase;
                      letter-spacing: 0.05em;
                      margin-bottom: 0.5rem;
                    ">
                    Count
                  </div>
                  <div style="
                      font-size: 3rem;
                      font-weight: 700;
                      color: #764ba2;
                      line-height: 1;
                    ">
                    {childView}
                  </div>
                </div>

                <div style="
                    background: #fef3c7;
                    border-left: 4px solid #f59e0b;
                    padding: 0.75rem;
                    border-radius: 0.5rem;
                    font-size: 0.85rem;
                    color: #78350f;
                  ">
                  Receives increments via stream when parent bubbles events
                </div>
              </div>
            </ct-card>
          </div>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                align-items: center;
                gap: 0.5rem;
              "
            >
              <span style="
                  font-size: 1.25rem;
                ">
                🫧
              </span>
              <h3 style="
                  margin: 0;
                  font-size: 1.1rem;
                  color: #0f172a;
                  font-weight: 600;
                ">
                Bubble Action
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <p style="
                  margin: 0;
                  color: #64748b;
                  font-size: 0.9rem;
                  line-height: 1.5;
                ">
                This action increments the parent counter and forwards the event
                to the child stream, updating both counters simultaneously.
              </p>

              <div style="
                  display: flex;
                  gap: 0.75rem;
                  align-items: stretch;
                ">
                <div style="flex: 1;">
                  <label style="
                      display: block;
                      font-size: 0.8rem;
                      font-weight: 600;
                      color: #475569;
                      margin-bottom: 0.5rem;
                    ">
                    Amount to bubble
                  </label>
                  <ct-input
                    type="number"
                    $value={bubbleAmount}
                    style="width: 100%;"
                  />
                </div>

                <div style="
                    display: flex;
                    align-items: flex-end;
                  ">
                  <ct-button
                    variant="primary"
                    onclick={performBubble}
                    style="
                      height: 2.5rem;
                      padding: 0 1.5rem;
                    "
                  >
                    <span style="
                        display: flex;
                        align-items: center;
                        gap: 0.5rem;
                      ">
                      <span>Bubble ↗</span>
                    </span>
                  </ct-button>
                </div>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                align-items: center;
                gap: 0.5rem;
              "
            >
              <span style="
                  font-size: 1.25rem;
                ">
                📜
              </span>
              <h3 style="
                  margin: 0;
                  font-size: 1.1rem;
                  color: #0f172a;
                  font-weight: 600;
                ">
                Bubble History
              </h3>
              <span style="
                  margin-left: auto;
                  background: #e0e7ff;
                  color: #3730a3;
                  padding: 0.25rem 0.75rem;
                  border-radius: 1rem;
                  font-size: 0.8rem;
                  font-weight: 600;
                ">
                {forwardedView} events
              </span>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
              "
            >
              {lift((records: BubbleRecord[]) => {
                if (records.length === 0) {
                  return (
                    <div style="
                        text-align: center;
                        padding: 2rem;
                        color: #94a3b8;
                        font-style: italic;
                      ">
                      No bubble events yet. Click "Bubble" to see events appear
                      here.
                    </div>
                  );
                }

                return (
                  <div style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.5rem;
                    ">
                    {records.slice().reverse().map((record, idx) => (
                      <div
                        key={idx}
                        style="
                          display: flex;
                          align-items: center;
                          gap: 1rem;
                          padding: 0.75rem;
                          background: #f8fafc;
                          border-radius: 0.5rem;
                          border-left: 4px solid #667eea;
                        "
                      >
                        <div style="
                            flex-shrink: 0;
                            width: 2.5rem;
                            height: 2.5rem;
                            background: #667eea;
                            color: white;
                            border-radius: 0.5rem;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            font-weight: 700;
                            font-size: 1.1rem;
                          ">
                          +{record.amount}
                        </div>
                        <div style="flex: 1;">
                          <div style="
                              font-weight: 600;
                              color: #0f172a;
                              font-size: 0.95rem;
                            ">
                            Bubbled via {record.via}
                          </div>
                          <div style="
                              font-size: 0.8rem;
                              color: #64748b;
                              margin-top: 0.25rem;
                            ">
                            Event #{records.length - idx}
                          </div>
                        </div>
                        <div style="
                            font-size: 1.5rem;
                            color: #cbd5e1;
                          ">
                          ↗
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })(historyView)}
            </div>
          </ct-card>
        </div>
      ),
      parentValue: parentView,
      child: childState,
      forwardedCount: forwardedView,
      bubbleHistory: historyView,
      bubbleToChild: bubbleToChild({
        childIncrement: asIncrementStream(childState.key("increment")),
        parent,
        history,
        forwardedCount,
      }),
      parentIncrement: parentIncrement({ parent }),
    };
  },
);
