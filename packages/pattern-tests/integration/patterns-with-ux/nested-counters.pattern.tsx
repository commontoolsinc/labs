/// <cts-enable />
import {
  Cell,
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

interface NestedCounterArgs {
  counters: Default<
    {
      left: Default<number, 0>;
      right: Default<number, 0>;
    },
    { left: 0; right: 0 }
  >;
}

const increment = handler(
  (_event: unknown, context: { target: Cell<number> }) => {
    context.target.set((context.target.get() ?? 0) + 1);
  },
);

const decrement = handler(
  (_event: unknown, context: { target: Cell<number> }) => {
    context.target.set((context.target.get() ?? 0) - 1);
  },
);

const adjustSingle = handler(
  (
    event: { amount?: number } | undefined,
    context: { target: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    context.target.set((context.target.get() ?? 0) + amount);
  },
);

const balanceCounters = handler(
  (_event: unknown, context: { left: Cell<number>; right: Cell<number> }) => {
    const leftValue = context.left.get() ?? 0;
    const rightValue = context.right.get() ?? 0;
    const average = Math.round((leftValue + rightValue) / 2);
    context.left.set(average);
    context.right.set(average);
  },
);

export const nestedCounters = recipe<NestedCounterArgs>(
  "Nested Counters",
  ({ counters }) => {
    const left = counters.key("left");
    const right = counters.key("right");

    const total = lift((values: { left: number; right: number }) =>
      values.left + values.right
    )({
      left,
      right,
    });

    const name = str`Left ${left} • Right ${right}`;

    const ui = (
      <ct-card style="max-width: 600px; margin: 2rem auto; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border-radius: 16px; padding: 1.5rem;">
        <h2 style="margin: 0 0 1.5rem 0; font-size: 1.5rem; text-align: center; font-weight: 600;">
          Nested Counters
        </h2>

        <div style="background: rgba(255,255,255,0.15); border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem;">
          <div style="text-align: center; margin-bottom: 0.5rem; font-size: 0.875rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.9;">
            Combined Total
          </div>
          <div style="text-align: center; font-size: 3rem; font-weight: 700; line-height: 1;">
            {total}
          </div>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1.5rem;">
          <ct-card style="background: rgba(255,255,255,0.2); border: 2px solid rgba(59, 130, 246, 0.5); border-radius: 12px; padding: 1rem;">
            <div style="text-align: center; margin-bottom: 0.5rem; font-size: 0.875rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.9;">
              Left Counter
            </div>
            <div style="text-align: center; font-size: 2.5rem; font-weight: 700; margin-bottom: 1rem;">
              {left}
            </div>
            <div style="display: flex; gap: 0.5rem;">
              <ct-button
                onClick={decrement({ target: left })}
                style="flex: 1; background: rgba(239, 68, 68, 0.3); border: 1px solid rgba(239, 68, 68, 0.5); color: white; padding: 0.75rem; border-radius: 8px; font-weight: 600; cursor: pointer;"
              >
                −1
              </ct-button>
              <ct-button
                onClick={increment({ target: left })}
                style="flex: 1; background: rgba(34, 197, 94, 0.3); border: 1px solid rgba(34, 197, 94, 0.5); color: white; padding: 0.75rem; border-radius: 8px; font-weight: 600; cursor: pointer;"
              >
                +1
              </ct-button>
            </div>
          </ct-card>

          <ct-card style="background: rgba(255,255,255,0.2); border: 2px solid rgba(236, 72, 153, 0.5); border-radius: 12px; padding: 1rem;">
            <div style="text-align: center; margin-bottom: 0.5rem; font-size: 0.875rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.9;">
              Right Counter
            </div>
            <div style="text-align: center; font-size: 2.5rem; font-weight: 700; margin-bottom: 1rem;">
              {right}
            </div>
            <div style="display: flex; gap: 0.5rem;">
              <ct-button
                onClick={decrement({ target: right })}
                style="flex: 1; background: rgba(239, 68, 68, 0.3); border: 1px solid rgba(239, 68, 68, 0.5); color: white; padding: 0.75rem; border-radius: 8px; font-weight: 600; cursor: pointer;"
              >
                −1
              </ct-button>
              <ct-button
                onClick={increment({ target: right })}
                style="flex: 1; background: rgba(34, 197, 94, 0.3); border: 1px solid rgba(34, 197, 94, 0.5); color: white; padding: 0.75rem; border-radius: 8px; font-weight: 600; cursor: pointer;"
              >
                +1
              </ct-button>
            </div>
          </ct-card>
        </div>

        <ct-button
          onClick={balanceCounters({ left, right })}
          style="width: 100%; background: rgba(251, 191, 36, 0.3); border: 2px solid rgba(251, 191, 36, 0.6); color: white; padding: 1rem; border-radius: 12px; font-weight: 600; cursor: pointer; font-size: 1rem;"
        >
          ⚖️ Balance Counters
        </ct-button>

        <div style="margin-top: 1rem; text-align: center; font-size: 0.75rem; opacity: 0.7;">
          Balance averages both counters
        </div>
      </ct-card>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      label: str`Left ${left} • Right ${right}`,
      counters: { left, right },
      total,
      controls: {
        incrementLeft: adjustSingle({ target: left }),
        incrementRight: adjustSingle({ target: right }),
        balance: balanceCounters({ left, right }),
      },
    };
  },
);
