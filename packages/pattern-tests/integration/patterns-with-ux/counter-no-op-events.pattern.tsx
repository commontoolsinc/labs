/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
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

interface NoOpCounterArgs {
  value: Default<number, 0>;
}

interface IncrementEvent {
  amount?: number;
}

const applyIncrement = handler(
  (
    event: IncrementEvent | undefined,
    context: {
      value: Cell<number>;
      updates: Cell<number>;
      lastEvent: Cell<string>;
    },
  ) => {
    const amount = event?.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount)) {
      return;
    }

    const currentRaw = context.value.get();
    const currentValue =
      typeof currentRaw === "number" && Number.isFinite(currentRaw)
        ? currentRaw
        : 0;
    const next = currentValue + amount;
    context.value.set(next);

    const updateRaw = context.updates.get();
    const applied = typeof updateRaw === "number" && Number.isFinite(updateRaw)
      ? updateRaw + 1
      : 1;
    context.updates.set(applied);
    context.lastEvent.set(`applied ${amount}`);
  },
);

const attemptIncrementValid = handler(
  (
    _event: undefined,
    context: {
      value: Cell<number>;
      updates: Cell<number>;
      lastEvent: Cell<string>;
    },
  ) => {
    const amount = 1;
    const currentRaw = context.value.get();
    const currentValue =
      typeof currentRaw === "number" && Number.isFinite(currentRaw)
        ? currentRaw
        : 0;
    const next = currentValue + amount;
    context.value.set(next);

    const updateRaw = context.updates.get();
    const applied = typeof updateRaw === "number" && Number.isFinite(updateRaw)
      ? updateRaw + 1
      : 1;
    context.updates.set(applied);
    context.lastEvent.set(`applied ${amount}`);
  },
);

const attemptIncrementInvalid = handler(
  (
    _event: undefined,
    context: {
      lastEvent: Cell<string>;
    },
  ) => {
    context.lastEvent.set("blocked invalid");
  },
);

export const counterNoOpEventsUx = recipe<NoOpCounterArgs>(
  "Counter No-Op Events (UX)",
  ({ value }) => {
    const updates = cell(0);
    const lastEvent = cell("none");

    const currentValue = lift((input: number | undefined) =>
      typeof input === "number" && Number.isFinite(input) ? input : 0
    )(value);
    const updateCount = lift((count: number | undefined) =>
      typeof count === "number" && Number.isFinite(count) ? count : 0
    )(updates);
    const lastEventView = lift((label: string | undefined) =>
      typeof label === "string" && label.length > 0 ? label : "none"
    )(lastEvent);
    const hasChanges = derive(updateCount, (count) => count > 0);
    const status = derive(
      hasChanges,
      (changed) => (changed ? "changed" : "no changes"),
    );

    const name = str`Counter value ${currentValue} (${status})`;

    const incrementValid = attemptIncrementValid({
      value,
      updates,
      lastEvent,
    });
    const incrementInvalid = attemptIncrementInvalid({ lastEvent });

    const lastEventColor = lift((evt: string) => {
      if (evt.startsWith("applied")) {
        return "#10b981";
      } else if (evt.startsWith("blocked")) {
        return "#ef4444";
      } else {
        return "#64748b";
      }
    })(lastEventView);

    const lastEventBg = lift((evt: string) => {
      if (evt.startsWith("applied")) {
        return "#d1fae5";
      } else if (evt.startsWith("blocked")) {
        return "#fee2e2";
      } else {
        return "#f1f5f9";
      }
    })(lastEventView);

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
                  No-Op Events Demo
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Counter with invalid event handling
                </h2>
                <p style="
                    margin: 0;
                    font-size: 0.9rem;
                    color: #64748b;
                  ">
                  Demonstrates how handlers validate event data and silently
                  reject invalid inputs without updating state
                </p>
              </div>

              <div style="
                  display: grid;
                  grid-template-columns: 1fr 1fr;
                  gap: 1rem;
                ">
                <div style="
                    background: #f8fafc;
                    border: 2px solid #e2e8f0;
                    border-radius: 0.5rem;
                    padding: 1rem;
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
                      font-size: 2.5rem;
                      font-weight: 700;
                      color: #0f172a;
                      font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace;
                    ">
                    {currentValue}
                  </div>
                </div>

                <div style="
                    background: #f8fafc;
                    border: 2px solid #e2e8f0;
                    border-radius: 0.5rem;
                    padding: 1rem;
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
                    Applied Updates
                  </span>
                  <div style="
                      font-size: 2.5rem;
                      font-weight: 700;
                      color: #0f172a;
                      font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace;
                    ">
                    {updateCount}
                  </div>
                </div>
              </div>

              <div
                style={lift(
                  ({ color, bg }: { color: string; bg: string }) =>
                    "background: " + bg + "; border: 2px solid " + color +
                    "; border-radius: 0.5rem; padding: 1rem; display: flex; flex-direction: column; gap: 0.5rem; align-items: center;",
                )({ color: lastEventColor, bg: lastEventBg })}
              >
                <span style="
                    color: #475569;
                    font-size: 0.7rem;
                    letter-spacing: 0.05em;
                    text-transform: uppercase;
                  ">
                  Last Event
                </span>
                <div
                  style={lift(
                    (color: string) =>
                      "font-size: 1.1rem; font-weight: 600; color: " + color +
                      "; font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace;",
                  )(lastEventColor)}
                >
                  {lastEventView}
                </div>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
                <div style="
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                  ">
                  <div style="
                      width: 0.75rem;
                      height: 0.75rem;
                      border-radius: 9999px;
                      background: #10b981;
                    ">
                  </div>
                  <span style="
                      color: #475569;
                      font-size: 0.8rem;
                    ">
                    Valid event (amount=1)
                  </span>
                </div>
                <ct-button
                  onClick={incrementValid}
                  style="width: 100%;"
                  aria-label="Increment with valid event"
                >
                  Valid Increment (+1)
                </ct-button>

                <div style="
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    margin-top: 0.5rem;
                  ">
                  <div style="
                      width: 0.75rem;
                      height: 0.75rem;
                      border-radius: 9999px;
                      background: #ef4444;
                    ">
                  </div>
                  <span style="
                      color: #475569;
                      font-size: 0.8rem;
                    ">
                    Invalid event (amount=undefined)
                  </span>
                </div>
                <ct-button
                  onClick={incrementInvalid}
                  style="width: 100%;"
                  aria-label="Attempt increment with invalid event"
                >
                  Invalid Increment (no-op)
                </ct-button>
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
                <strong>Pattern:</strong> The handler validates that
                <code style="
                    background: #fef9e7;
                    padding: 0.125rem 0.375rem;
                    border-radius: 0.25rem;
                    font-size: 0.75rem;
                  ">
                  amount
                </code>{" "}
                is a finite number. Invalid events are silently rejected—no
                state changes occur, keeping the counter and update count
                unchanged.
              </div>
            </div>
          </ct-card>
        </div>
      ),
      value,
      currentValue,
      updateCount,
      hasChanges,
      status,
      lastEvent: lastEventView,
      increment: applyIncrement({ value, updates, lastEvent }),
    };
  },
);

export default counterNoOpEventsUx;
