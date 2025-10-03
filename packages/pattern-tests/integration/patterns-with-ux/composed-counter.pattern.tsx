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

const bump = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    context.value.set((context.value.get() ?? 0) + amount);
  },
);

const mirrorRight = handler(
  (_event: unknown, context: { left: Cell<number>; right: Cell<number> }) => {
    const leftValue = context.left.get() ?? 0;
    context.right.set(leftValue);
  },
);

const childCounter = recipe<{ value: Default<number, 0> }>(
  "Child Counter",
  ({ value }) => {
    return {
      label: str`Value ${value}`,
      value,
      increment: bump({ value }),
    };
  },
);

interface ComposedCounterArgs {
  left: Default<number, 0>;
  right: Default<number, 0>;
}

export const composedCountersUx = recipe<ComposedCounterArgs>(
  "Composed Counters (UX)",
  ({ left, right }) => {
    const leftCounter = childCounter({ value: left });
    const rightCounter = childCounter({ value: right });

    const total = lift((values: { left: number; right: number }) =>
      values.left + values.right
    )({
      left: leftCounter.key("value"),
      right: rightCounter.key("value"),
    });

    const name = str`Composed Counters (L${
      leftCounter.key(
        "value",
      )
    }+R${rightCounter.key("value")}=${total})`;

    const totalBar = lift((t: number) => {
      const percentage = Math.min(100, (t / 20) * 100);
      return h(
        "div",
        {
          style:
            "background: #e0e7ff; border-radius: 0.5rem; height: 1.5rem; overflow: hidden; position: relative;",
        },
        h("div", {
          style:
            "background: linear-gradient(90deg, #818cf8 0%, #6366f1 100%); height: 100%; transition: width 0.3s ease; width: " +
            String(percentage) + "%;",
        }),
        h(
          "div",
          {
            style:
              "position: absolute; top: 0; left: 0; right: 0; bottom: 0; display: flex; align-items: center; justify-content: center; font-size: 0.85rem; font-weight: 600; color: #1e1b4b;",
          },
          String(t),
        ),
      );
    })(total);

    return {
      [NAME]: name,
      [UI]: (
        <div style="display: flex; flex-direction: column; gap: 1.5rem; max-width: 48rem;">
          <ct-card>
            <div
              slot="content"
              style="display: flex; flex-direction: column; gap: 1rem;"
            >
              <div style="display: flex; flex-direction: column; gap: 0.25rem;">
                <span style="color: #475569; font-size: 0.75rem; letter-spacing: 0.08em; text-transform: uppercase;">
                  Recipe Composition Pattern
                </span>
                <h2 style="margin: 0; font-size: 1.3rem; color: #0f172a;">
                  Composed Child Counters
                </h2>
                <p style="margin: 0; font-size: 0.9rem; color: #64748b;">
                  Demonstrates recipe composition with two independent child
                  counter recipes, derived total from both values, and a
                  synchronization action to mirror left to right.
                </p>
              </div>

              <div style="background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); color: white; padding: 2rem; border-radius: 0.75rem; text-align: center;">
                <div style="font-size: 0.75rem; opacity: 0.9; margin-bottom: 0.5rem;">
                  Combined Total
                </div>
                <div style="font-size: 3rem; font-weight: 700;">{total}</div>
                <div style="font-size: 0.85rem; opacity: 0.85; margin-top: 0.5rem;">
                  {leftCounter.key("value")} + {rightCounter.key("value")}
                </div>
              </div>

              {totalBar}

              <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem;">
                <ct-card>
                  <div slot="header">
                    <h3 style="margin: 0; font-size: 1rem; color: #0891b2; display: flex; align-items: center; gap: 0.5rem;">
                      <span style="width: 8px; height: 8px; border-radius: 50%; background: #0891b2;">
                      </span>
                      Left Counter
                    </h3>
                  </div>
                  <div
                    slot="content"
                    style="display: flex; flex-direction: column; gap: 1rem;"
                  >
                    <div style="background: linear-gradient(135deg, #06b6d4 0%, #0891b2 100%); color: white; padding: 1.5rem; border-radius: 0.75rem; text-align: center;">
                      <div style="font-size: 0.75rem; opacity: 0.9; margin-bottom: 0.5rem;">
                        Value
                      </div>
                      <div style="font-size: 2.5rem; font-weight: 700;">
                        {leftCounter.key("value")}
                      </div>
                    </div>

                    <ct-button
                      onClick={leftCounter.key("increment")}
                      aria-label="Increment left"
                    >
                      +1
                    </ct-button>

                    <ct-button
                      variant="secondary"
                      onClick={leftCounter.key("increment")}
                      ct-amount={5}
                      aria-label="Increment left by 5"
                    >
                      +5
                    </ct-button>
                  </div>
                </ct-card>

                <ct-card>
                  <div slot="header">
                    <h3 style="margin: 0; font-size: 1rem; color: #ec4899; display: flex; align-items: center; gap: 0.5rem;">
                      <span style="width: 8px; height: 8px; border-radius: 50%; background: #ec4899;">
                      </span>
                      Right Counter
                    </h3>
                  </div>
                  <div
                    slot="content"
                    style="display: flex; flex-direction: column; gap: 1rem;"
                  >
                    <div style="background: linear-gradient(135deg, #ec4899 0%, #db2777 100%); color: white; padding: 1.5rem; border-radius: 0.75rem; text-align: center;">
                      <div style="font-size: 0.75rem; opacity: 0.9; margin-bottom: 0.5rem;">
                        Value
                      </div>
                      <div style="font-size: 2.5rem; font-weight: 700;">
                        {rightCounter.key("value")}
                      </div>
                    </div>

                    <ct-button
                      onClick={rightCounter.key("increment")}
                      aria-label="Increment right"
                    >
                      +1
                    </ct-button>

                    <ct-button
                      variant="secondary"
                      onClick={rightCounter.key("increment")}
                      ct-amount={5}
                      aria-label="Increment right by 5"
                    >
                      +5
                    </ct-button>
                  </div>
                </ct-card>
              </div>

              <ct-card>
                <div slot="header">
                  <h3 style="margin: 0; font-size: 1rem; color: #7c3aed;">
                    Synchronization Action
                  </h3>
                </div>
                <div
                  slot="content"
                  style="display: flex; flex-direction: column; gap: 1rem;"
                >
                  <div style="background: #faf5ff; border-radius: 0.5rem; padding: 1rem; border: 1px solid #e9d5ff;">
                    <div style="font-size: 0.85rem; color: #475569; line-height: 1.6;">
                      <strong>Mirror action:</strong>{" "}
                      Copies the left counter value to the right counter,
                      demonstrating cross-recipe state manipulation through
                      handlers.
                    </div>
                  </div>

                  <ct-button
                    onClick={mirrorRight({
                      left: leftCounter.key("value"),
                      right: rightCounter.key("value"),
                    })}
                    aria-label="Mirror left to right"
                  >
                    Mirror Left → Right
                  </ct-button>
                </div>
              </ct-card>
            </div>
          </ct-card>

          <div
            role="status"
            aria-live="polite"
            data-testid="status"
            style="font-size: 0.85rem; color: #475569;"
          >
            Total: {total}
          </div>
        </div>
      ),
      left: leftCounter,
      right: rightCounter,
      total,
      actions: {
        mirrorRight: mirrorRight({
          left: leftCounter.key("value"),
          right: rightCounter.key("value"),
        }),
      },
    };
  },
);

export default composedCountersUx;
