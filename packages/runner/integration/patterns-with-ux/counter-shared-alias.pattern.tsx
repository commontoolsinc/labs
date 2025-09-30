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

interface SharedAliasArgs {
  value: Default<number, 0>;
}

const sharedIncrement = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const next = (context.value.get() ?? 0) + amount;
    context.value.set(next);
  },
);

export const counterWithSharedAliasUx = recipe<SharedAliasArgs>(
  "Counter With Shared Alias (UX)",
  ({ value }) => {
    const safeValue = lift((count: number | undefined) =>
      typeof count === "number" ? count : 0
    )(value);
    const label = str`Value ${safeValue}`;

    const increment = sharedIncrement({ value });

    const name = str`Shared counter (${safeValue})`;

    const progressPercent = lift((v: number) => {
      const normalized = Math.max(0, Math.min(v, 100));
      return normalized;
    })(safeValue);

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
                  Shared Counter
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Demonstrates a shared handler across multiple aliases
                </h2>
              </div>

              <div style="
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  border-radius: 0.75rem;
                  padding: 2rem;
                  display: flex;
                  flex-direction: column;
                  align-items: center;
                  gap: 0.5rem;
                ">
                <span style="font-size: 0.9rem; color: #fff; opacity: 0.9;">
                  Current value
                </span>
                <strong style="
                    font-size: 3rem;
                    color: #fff;
                    font-variant-numeric: tabular-nums;
                  ">
                  {safeValue}
                </strong>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
                <h3 style="
                    margin: 0;
                    font-size: 0.875rem;
                    font-weight: 600;
                    color: #334155;
                  ">
                  Mirrors (aliases of the same value)
                </h3>

                <div style="
                    display: grid;
                    grid-template-columns: repeat(2, 1fr);
                    gap: 0.75rem;
                  ">
                  <div style="
                      background: #f1f5f9;
                      border: 2px solid #3b82f6;
                      border-radius: 0.5rem;
                      padding: 1rem;
                      display: flex;
                      flex-direction: column;
                      align-items: center;
                      gap: 0.5rem;
                    ">
                    <span style="
                        font-size: 0.75rem;
                        color: #3b82f6;
                        font-weight: 600;
                        text-transform: uppercase;
                        letter-spacing: 0.05em;
                      ">
                      Left Mirror
                    </span>
                    <strong style="
                        font-size: 1.75rem;
                        color: #1e40af;
                        font-variant-numeric: tabular-nums;
                      ">
                      {safeValue}
                    </strong>
                  </div>

                  <div style="
                      background: #f1f5f9;
                      border: 2px solid #ec4899;
                      border-radius: 0.5rem;
                      padding: 1rem;
                      display: flex;
                      flex-direction: column;
                      align-items: center;
                      gap: 0.5rem;
                    ">
                    <span style="
                        font-size: 0.75rem;
                        color: #ec4899;
                        font-weight: 600;
                        text-transform: uppercase;
                        letter-spacing: 0.05em;
                      ">
                      Right Mirror
                    </span>
                    <strong style="
                        font-size: 1.75rem;
                        color: #be185d;
                        font-variant-numeric: tabular-nums;
                      ">
                      {safeValue}
                    </strong>
                  </div>
                </div>

                <div style="
                    background: #fef3c7;
                    border-left: 3px solid #f59e0b;
                    border-radius: 0.25rem;
                    padding: 0.75rem;
                    font-size: 0.8rem;
                    color: #78350f;
                  ">
                  <strong>Pattern insight:</strong>{" "}
                  All three displays (current, left, right) reference the same
                  underlying value. The shared increment handler updates all
                  simultaneously.
                </div>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                ">
                <ct-button onClick={increment} aria-label="Increment counter">
                  Increment (+1)
                </ct-button>

                <div style="
                    display: flex;
                    justify-content: space-between;
                    font-size: 0.75rem;
                    color: #64748b;
                  ">
                  <span>Progress to 100:</span>
                  <span>{progressPercent}%</span>
                </div>
                <div style="
                    position: relative;
                    height: 0.375rem;
                    background: #e2e8f0;
                    border-radius: 0.25rem;
                    overflow: hidden;
                  ">
                  <div
                    style={lift(
                      (pct: number) =>
                        "position: absolute; left: 0; top: 0; bottom: 0; width: " +
                        String(pct) +
                        "%; background: linear-gradient(90deg, #10b981, #059669); border-radius: 0.25rem; transition: width 0.3s ease;",
                    )(progressPercent)}
                  >
                  </div>
                </div>
              </div>
            </div>
          </ct-card>

          <div
            role="status"
            aria-live="polite"
            data-testid="status"
            style="font-size: 0.85rem; color: #475569;"
          >
            {label}
          </div>
        </div>
      ),
      value,
      label,
      current: safeValue,
      mirrors: {
        left: safeValue,
        right: safeValue,
      },
      increment,
    };
  },
);

export default counterWithSharedAliasUx;
