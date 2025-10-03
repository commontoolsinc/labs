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

interface NestedStreamArgs {
  value: Default<number, 0>;
}

const nestedIncrement = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const next = (context.value.get() ?? 0) + amount;
    context.value.set(next);
  },
);

/** Pattern demonstrating a nested stream handler with UX. */
export const counterWithNestedStreamUx = recipe<NestedStreamArgs>(
  "Counter With Nested Stream (UX)",
  ({ value }) => {
    // Create UI cells for custom input
    const customAmountField = cell<string>("");

    // Create separate handlers for each increment amount
    const createIncrementHandler = (amount: number) =>
      handler<
        unknown,
        { value: Cell<number> }
      >((_event, ctx) => {
        const next = (ctx.value.get() ?? 0) + amount;
        ctx.value.set(next);
      })({ value });

    const increment1 = createIncrementHandler(1);
    const increment5 = createIncrementHandler(5);
    const increment10 = createIncrementHandler(10);

    // The original nested stream handler (for export compatibility)
    const incrementStream = nestedIncrement({ value });

    // UI handler for custom increment
    const customIncrement = handler<
      unknown,
      {
        customAmountField: Cell<string>;
        value: Cell<number>;
      }
    >((_event, ctx) => {
      const amountStr = ctx.customAmountField.get();
      if (typeof amountStr === "string" && amountStr.trim() !== "") {
        const amount = Number(amountStr.trim());
        if (Number.isFinite(amount)) {
          const next = (ctx.value.get() ?? 0) + amount;
          ctx.value.set(next);
          ctx.customAmountField.set("");
        }
      }
    })({
      customAmountField,
      value,
    });

    // Derived values for UI
    const currentValue = lift((v: number | undefined) => v ?? 0)(value);
    const label = str`Counter ${value}`;
    const name = str`Nested stream (${currentValue})`;

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 40rem;
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
                  Nested stream handler
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Counter with nested stream invocation
                </h2>
                <p style="
                    margin: 0;
                    font-size: 0.9rem;
                    color: #64748b;
                  ">
                  Demonstrates a handler factory invoked with cell context
                  inside the recipe's stream output, creating a bound handler
                  that operates on the provided cells.
                </p>
              </div>

              <div style="
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  border-radius: 0.75rem;
                  padding: 1.5rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                  align-items: center;
                ">
                <span style="
                    font-size: 0.85rem;
                    color: rgba(255, 255, 255, 0.9);
                    font-weight: 500;
                  ">
                  Current value
                </span>
                <strong style="
                    font-size: 3.5rem;
                    color: white;
                    font-weight: 700;
                    font-family: monospace;
                  ">
                  {currentValue}
                </strong>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
                <h3 style="
                    margin: 0;
                    font-size: 0.95rem;
                    color: #334155;
                    font-weight: 600;
                  ">
                  Quick increment actions
                </h3>
                <div style="
                    display: grid;
                    grid-template-columns: repeat(3, 1fr);
                    gap: 0.5rem;
                  ">
                  <ct-button
                    onClick={increment1}
                    aria-label="Increment by 1"
                  >
                    +1
                  </ct-button>
                  <ct-button
                    onClick={increment5}
                    variant="secondary"
                    aria-label="Increment by 5"
                  >
                    +5
                  </ct-button>
                  <ct-button
                    onClick={increment10}
                    variant="secondary"
                    aria-label="Increment by 10"
                  >
                    +10
                  </ct-button>
                </div>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
                <h3 style="
                    margin: 0;
                    font-size: 0.95rem;
                    color: #334155;
                    font-weight: 600;
                  ">
                  Custom increment
                </h3>
                <div style="
                    display: flex;
                    gap: 0.5rem;
                    align-items: flex-end;
                  ">
                  <div style="
                      flex: 1;
                      display: flex;
                      flex-direction: column;
                      gap: 0.4rem;
                    ">
                    <label
                      for="custom-amount"
                      style="
                        font-size: 0.85rem;
                        font-weight: 500;
                        color: #334155;
                      "
                    >
                      Amount
                    </label>
                    <ct-input
                      id="custom-amount"
                      type="number"
                      step="1"
                      placeholder="Enter any number"
                      $value={customAmountField}
                      aria-label="Custom increment amount"
                    >
                    </ct-input>
                  </div>
                  <ct-button
                    onClick={customIncrement}
                    aria-label="Apply custom increment"
                  >
                    Apply
                  </ct-button>
                </div>
              </div>
            </div>
          </ct-card>

          <div
            role="status"
            aria-live="polite"
            data-testid="label"
            style="
              font-size: 0.85rem;
              color: #475569;
              text-align: center;
            "
          >
            {label}
          </div>
        </div>
      ),
      value,
      label,
      streams: {
        increment: incrementStream,
      },
    };
  },
);

export default counterWithNestedStreamUx;
