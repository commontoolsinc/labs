/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
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

interface LiftFormattingArgs {
  value: Default<number, 0>;
}

const addOne = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const next = (context.value.get() ?? 0) + amount;
    context.value.set(next);
  },
);

export const counterWithLiftFormattingUx = recipe<LiftFormattingArgs>(
  "Counter With Lift Formatting (UX)",
  ({ value }) => {
    const formatted = lift((count: number) => `Value: ${count.toFixed(2)}`)(
      value,
    );

    const increment = addOne({ value });

    const name = str`Counter with formatting (${formatted})`;

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
                  Lift Formatting Demo
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Counter with formatted display
                </h2>
                <p style="
                    margin: 0;
                    font-size: 0.9rem;
                    color: #64748b;
                  ">
                  Demonstrates using lift to format a numeric counter value
                </p>
              </div>

              <div style="
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  border-radius: 0.75rem;
                  padding: 1.5rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                  align-items: center;
                ">
                <span style="
                    color: rgba(255, 255, 255, 0.8);
                    font-size: 0.8rem;
                    letter-spacing: 0.05em;
                    text-transform: uppercase;
                  ">
                  Raw value
                </span>
                <div style="
                    font-size: 3rem;
                    font-weight: 700;
                    color: white;
                    font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace;
                  ">
                  {value}
                </div>
              </div>

              <div style="
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  gap: 0.5rem;
                ">
                <div style="
                    width: 2rem;
                    height: 0.125rem;
                    background: linear-gradient(90deg, transparent, #cbd5e1);
                  ">
                </div>
                <span style="
                    color: #94a3b8;
                    font-size: 0.75rem;
                    letter-spacing: 0.1em;
                    text-transform: uppercase;
                  ">
                  lift transformation
                </span>
                <div style="
                    width: 2rem;
                    height: 0.125rem;
                    background: linear-gradient(90deg, #cbd5e1, transparent);
                  ">
                </div>
              </div>

              <div style="
                  background: #f8fafc;
                  border: 2px solid #e2e8f0;
                  border-radius: 0.75rem;
                  padding: 1.5rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                  align-items: center;
                ">
                <span style="
                    color: #475569;
                    font-size: 0.8rem;
                    letter-spacing: 0.05em;
                    text-transform: uppercase;
                  ">
                  Formatted output
                </span>
                <div style="
                    font-size: 2rem;
                    font-weight: 600;
                    color: #0f172a;
                    font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace;
                  ">
                  {formatted}
                </div>
                <div style="
                    font-size: 0.75rem;
                    color: #64748b;
                    text-align: center;
                    max-width: 20rem;
                  ">
                  The lift function applies{" "}
                  <code style="
                      background: #e2e8f0;
                      padding: 0.125rem 0.375rem;
                      border-radius: 0.25rem;
                      font-size: 0.7rem;
                    ">
                    .toFixed(2)
                  </code>{" "}
                  formatting to display exactly two decimal places
                </div>
              </div>

              <ct-button
                onClick={increment}
                style="width: 100%;"
                aria-label="Increment counter by one"
              >
                Increment (+1)
              </ct-button>
            </div>
          </ct-card>
        </div>
      ),
      value,
      formatted,
      increment,
    };
  },
);

export default counterWithLiftFormattingUx;
