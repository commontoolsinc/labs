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

interface DoubleCounterArgs {
  left: Default<number, 0>;
  right: Default<number, 0>;
}

const incrementBoth = handler(
  (
    event: { amount?: number } | undefined,
    context: { left: Cell<number>; right: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const nextLeft = (context.left.get() ?? 0) + amount;
    const nextRight = (context.right.get() ?? 0) + amount;
    context.left.set(nextLeft);
    context.right.set(nextRight);
  },
);

const incrementBy = (amount: number) =>
  handler<unknown, { left: Cell<number>; right: Cell<number> }>(
    (_event, { left, right }) => {
      const nextLeft = (left.get() ?? 0) + amount;
      const nextRight = (right.get() ?? 0) + amount;
      left.set(nextLeft);
      right.set(nextRight);
    },
  );

const applyPresetIncrement = handler<
  unknown,
  { left: Cell<number>; right: Cell<number>; amount: Cell<number> }
>((_event, { left, right, amount }) => {
  const step = amount.get();
  const nextLeft = (left.get() ?? 0) + step;
  const nextRight = (right.get() ?? 0) + step;
  left.set(nextLeft);
  right.set(nextRight);
});

export const doubleCounterWithSharedIncrementUx = recipe<DoubleCounterArgs>(
  "Double Counter With Shared Increment (UX)",
  ({ left, right }) => {
    const status = str`left ${left} • right ${right}`;
    const total = lift((values: { left: number; right: number }) =>
      values.left + values.right
    )({ left, right });
    const name = str`Shared increment (${left} & ${right})`;

    const leftValue = derive(left, (value) => value ?? 0);
    const rightValue = derive(right, (value) => value ?? 0);
    const totalValue = derive(total, (value) => value ?? 0);

    const preset = cell("1");
    const presetAmount = lift(({ value }: { value: string }) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    })({ value: preset });

    const addOne = incrementBy(1)({ left, right });
    const addFive = incrementBy(5)({ left, right });
    const addTen = incrementBy(10)({ left, right });
    const addPreset = applyPresetIncrement({
      left,
      right,
      amount: presetAmount,
    });

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
                  gap: 0.25rem;
                ">
                <span style="
                    font-size: 0.75rem;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                    color: #475569;
                  ">
                  Shared counters
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.25rem;
                    line-height: 1.4;
                  ">
                  Move both counters together
                </h2>
                <p style="
                    margin: 0;
                    color: #475569;
                    font-size: 0.95rem;
                  ">
                  Every increment keeps the left and right counters aligned.
                </p>
              </div>

              <div style="
                  display: grid;
                  grid-template-columns: repeat(3, minmax(0, 1fr));
                  gap: 0.75rem;
                ">
                <div style="
                    background: #f1f5f9;
                    border-radius: 0.75rem;
                    padding: 0.75rem;
                    text-align: center;
                  ">
                  <span style="
                      display: block;
                      font-size: 0.75rem;
                      color: #475569;
                    ">
                    Left count
                  </span>
                  <strong
                    data-testid="left-value"
                    style="
                      display: block;
                      font-size: 1.5rem;
                    "
                  >
                    {leftValue}
                  </strong>
                </div>
                <div style="
                    background: #f8fafc;
                    border-radius: 0.75rem;
                    padding: 0.75rem;
                    text-align: center;
                  ">
                  <span style="
                      display: block;
                      font-size: 0.75rem;
                      color: #475569;
                    ">
                    Right count
                  </span>
                  <strong
                    data-testid="right-value"
                    style="
                      display: block;
                      font-size: 1.5rem;
                    "
                  >
                    {rightValue}
                  </strong>
                </div>
                <div style="
                    background: #e2e8f0;
                    border-radius: 0.75rem;
                    padding: 0.75rem;
                    text-align: center;
                  ">
                  <span style="
                      display: block;
                      font-size: 0.75rem;
                      color: #475569;
                    ">
                    Total
                  </span>
                  <strong
                    data-testid="total-value"
                    style="
                      display: block;
                      font-size: 1.5rem;
                    "
                  >
                    {totalValue}
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
                gap: 0.75rem;
              "
            >
              <div style="
                  display: flex;
                  flex-wrap: wrap;
                  gap: 0.5rem;
                ">
                <ct-button onClick={addOne}>
                  Add 1 to both
                </ct-button>
                <ct-button
                  variant="secondary"
                  onClick={addFive}
                >
                  Add 5
                </ct-button>
                <ct-button variant="ghost" onClick={addTen}>
                  Add 10
                </ct-button>
              </div>
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                ">
                <label
                  style="
                    font-size: 0.85rem;
                    font-weight: 500;
                    color: #334155;
                  "
                  for="shared-increment-step"
                >
                  Custom step
                </label>
                <div style="
                    display: flex;
                    flex-wrap: wrap;
                    align-items: center;
                    gap: 0.5rem;
                  ">
                  <ct-input
                    id="shared-increment-step"
                    type="number"
                    min="1"
                    step="1"
                    $value={preset}
                    aria-label="Set custom increment amount"
                  >
                  </ct-input>
                  <ct-button onClick={addPreset}>
                    Apply {presetAmount}
                  </ct-button>
                </div>
                <span style="
                    font-size: 0.8rem;
                    color: #64748b;
                  ">
                  Negative or empty values fall back to 1.
                </span>
              </div>
            </div>
          </ct-card>

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
      ),
      left,
      right,
      status,
      total,
      controls: {
        increment: incrementBoth({ left, right }),
      },
    };
  },
);

export default doubleCounterWithSharedIncrementUx;
