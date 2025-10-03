/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

interface CounterState {
  value: Default<number, 0>;
}

const incrementBy1 = handler(
  (_event: unknown, context: { value: Cell<number> }) => {
    context.value.set((context.value.get() ?? 0) + 1);
  },
);

const incrementBy5 = handler(
  (_event: unknown, context: { value: Cell<number> }) => {
    context.value.set((context.value.get() ?? 0) + 5);
  },
);

const incrementBy10 = handler(
  (_event: unknown, context: { value: Cell<number> }) => {
    context.value.set((context.value.get() ?? 0) + 10);
  },
);

const decrementBy1 = handler(
  (_event: unknown, context: { value: Cell<number> }) => {
    context.value.set((context.value.get() ?? 0) - 1);
  },
);

export const simpleCounterUx = recipe<CounterState>(
  "Simple Counter (UX)",
  ({ value }) => {
    const inc1 = incrementBy1({ value });
    const inc5 = incrementBy5({ value });
    const inc10 = incrementBy10({ value });
    const dec1 = decrementBy1({ value });

    const name = str`Counter: ${value}`;

    const valueColor = lift((v: number) => {
      if (v < 0) return "#ef4444";
      if (v > 0) return "#10b981";
      return "#64748b";
    })(value);

    const valueBg = lift((v: number) => {
      if (v < 0) return "linear-gradient(135deg, #fee2e2, #fecaca)";
      if (v > 0) return "linear-gradient(135deg, #d1fae5, #a7f3d0)";
      return "linear-gradient(135deg, #f1f5f9, #e2e8f0)";
    })(value);

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
                  Simple Counter
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Basic counter with increment actions
                </h2>
              </div>

              <div
                style={lift(
                  (bg: string) =>
                    "background: " + bg +
                    "; border-radius: 0.75rem; padding: 2rem; display: flex; flex-direction: column; align-items: center; gap: 1.5rem; transition: background 0.3s ease;",
                )(valueBg)}
              >
                <div style="
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 0.5rem;
                  ">
                  <span style="
                      font-size: 0.875rem;
                      color: #64748b;
                      font-weight: 500;
                      text-transform: uppercase;
                      letter-spacing: 0.05em;
                    ">
                    Current Value
                  </span>
                  <span
                    style={lift(
                      (color: string) =>
                        "font-size: 3.5rem; font-weight: 700; color: " + color +
                        "; font-family: monospace; transition: color 0.3s ease;",
                    )(valueColor)}
                  >
                    {value}
                  </span>
                </div>

                <div style="
                    display: flex;
                    gap: 0.75rem;
                    flex-wrap: wrap;
                    justify-content: center;
                  ">
                  <ct-button
                    onClick={inc1}
                    aria-label="Increment by 1"
                  >
                    +1
                  </ct-button>
                  <ct-button
                    onClick={inc5}
                    aria-label="Increment by 5"
                  >
                    +5
                  </ct-button>
                  <ct-button
                    onClick={inc10}
                    aria-label="Increment by 10"
                  >
                    +10
                  </ct-button>
                  <ct-button
                    onClick={dec1}
                    aria-label="Decrement by 1"
                  >
                    -1
                  </ct-button>
                </div>
              </div>

              <div style="
                  background: #f8fafc;
                  border-radius: 0.5rem;
                  padding: 1rem;
                  font-size: 0.85rem;
                  color: #475569;
                  line-height: 1.5;
                ">
                <strong>Pattern:</strong>{" "}
                This demonstrates a simple counter with increment actions. The
                handler accepts an optional{" "}
                <code style="
                    background: #e2e8f0;
                    padding: 0.1rem 0.3rem;
                    border-radius: 0.25rem;
                    font-family: monospace;
                  ">
                  amount
                </code>{" "}
                parameter to increment by different values. Color-coded visual
                feedback shows negative (red), zero (gray), and positive (green)
                states.
              </div>
            </div>
          </ct-card>
        </div>
      ),
      value,
      increment: inc1,
    };
  },
);

export default simpleCounterUx;
