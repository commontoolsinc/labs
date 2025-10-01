/// <cts-enable />
// @ts-nocheck
import {
  Cell,
  cell,
  compute,
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

interface MutableTupleArgs {
  pair: Default<[number, number], [0, 0]>;
}

const setPair = handler(
  (
    event: { left?: number; right?: number } | undefined,
    context: { pair: Cell<[number, number]> },
  ) => {
    const left = typeof event?.left === "number" ? event.left : 0;
    const right = typeof event?.right === "number" ? event.right : 0;
    context.pair.set([left, right]);
  },
);

const adjustPair = handler(
  (
    event: { left?: number; right?: number } | undefined,
    context: { pair: Cell<[number, number]> },
  ) => {
    const current = context.pair.get() ?? [0, 0];
    const leftDelta = typeof event?.left === "number" ? event.left : 0;
    const rightDelta = typeof event?.right === "number" ? event.right : 0;
    context.pair.set([
      current[0] + leftDelta,
      current[1] + rightDelta,
    ]);
  },
);

export const counterWithMutableTuple = recipe<MutableTupleArgs>(
  "Counter With Mutable Tuple",
  ({ pair }) => {
    const initialize = compute(() => {
      if (!Array.isArray(pair.get())) {
        pair.set([0, 0]);
      }
    });

    const tuple = lift((values: [number, number] | undefined) => {
      const leftValue = Array.isArray(values) && typeof values[0] === "number"
        ? values[0]
        : 0;
      const rightValue = Array.isArray(values) && typeof values[1] === "number"
        ? values[1]
        : 0;
      return [leftValue, rightValue] as [number, number];
    })(pair);

    const left = lift((values: [number, number]) => values[0])(tuple);
    const right = lift((values: [number, number]) => values[1])(tuple);
    const sum = lift((values: [number, number]) => values[0] + values[1])(
      tuple,
    );
    const label = str`Tuple (${left}, ${right}) sum ${sum}`;

    // UI form fields
    const leftInput = cell<string>("0");
    const rightInput = cell<string>("0");

    // Sync input fields with tuple values
    const syncInputs = compute(() => {
      const [l, r] = tuple.get();
      if (leftInput.get() !== String(l)) {
        leftInput.set(String(l));
      }
      if (rightInput.get() !== String(r)) {
        rightInput.set(String(r));
      }
    });

    // Handler to update pair from inputs
    const updateFromInputs = handler(
      (
        _event: unknown,
        context: {
          pair: Cell<[number, number]>;
          leftInput: Cell<string>;
          rightInput: Cell<string>;
        },
      ) => {
        const leftStr = context.leftInput.get();
        const rightStr = context.rightInput.get();
        const leftNum = Number(leftStr);
        const rightNum = Number(rightStr);
        const left = Number.isFinite(leftNum) ? leftNum : 0;
        const right = Number.isFinite(rightNum) ? rightNum : 0;
        context.pair.set([left, right]);
      },
    );

    // Increment handlers
    const incrementLeft = handler(
      (
        _event: unknown,
        context: { pair: Cell<[number, number]> },
      ) => {
        const current = context.pair.get() ?? [0, 0];
        context.pair.set([current[0] + 1, current[1]]);
      },
    );

    const decrementLeft = handler(
      (
        _event: unknown,
        context: { pair: Cell<[number, number]> },
      ) => {
        const current = context.pair.get() ?? [0, 0];
        context.pair.set([current[0] - 1, current[1]]);
      },
    );

    const incrementRight = handler(
      (
        _event: unknown,
        context: { pair: Cell<[number, number]> },
      ) => {
        const current = context.pair.get() ?? [0, 0];
        context.pair.set([current[0], current[1] + 1]);
      },
    );

    const decrementRight = handler(
      (
        _event: unknown,
        context: { pair: Cell<[number, number]> },
      ) => {
        const current = context.pair.get() ?? [0, 0];
        context.pair.set([current[0], current[1] - 1]);
      },
    );

    const resetPair = handler(
      (
        _event: unknown,
        context: { pair: Cell<[number, number]> },
      ) => {
        context.pair.set([0, 0]);
      },
    );

    const name = str`Tuple Counter`;

    return {
      pair,
      tuple,
      left,
      right,
      sum,
      label,
      set: setPair({ pair }),
      adjust: adjustPair({ pair }),
      effects: { initialize, syncInputs },
      [NAME]: name,
      [UI]: (
        <div style="
          font-family: system-ui, -apple-system, sans-serif;
          max-width: 480px;
          margin: 0 auto;
          padding: 20px;
          background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
          min-height: 100vh;
        ">
          <div style="
            background: white;
            border-radius: 16px;
            padding: 24px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
          ">
            <h1 style="
              margin: 0 0 20px 0;
              font-size: 24px;
              font-weight: 700;
              color: #1f2937;
              text-align: center;
            ">
              Tuple Counter
            </h1>

            {/* Sum Display */}
            <div style="
              background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
              border-radius: 12px;
              padding: 24px;
              text-align: center;
              margin-bottom: 24px;
            ">
              <div style="
                color: rgba(255,255,255,0.9);
                font-size: 14px;
                margin-bottom: 8px;
              ">
                Sum
              </div>
              <div style="
                font-size: 56px;
                font-weight: 700;
                color: white;
              ">
                {sum}
              </div>
            </div>

            {/* Left Value */}
            <div style="
              background: #fef3c7;
              border-radius: 12px;
              padding: 20px;
              margin-bottom: 16px;
            ">
              <div style="
                font-size: 12px;
                font-weight: 600;
                color: #92400e;
                margin-bottom: 12px;
                text-align: center;
              ">
                LEFT VALUE
              </div>
              <div style="
                display: flex;
                align-items: center;
                gap: 12px;
                margin-bottom: 12px;
              ">
                <ct-button
                  onClick={decrementLeft({ pair })}
                  style="
                    background: #f59e0b;
                    color: white;
                    border: none;
                    width: 48px;
                    height: 48px;
                    border-radius: 8px;
                    font-size: 24px;
                    font-weight: 700;
                    cursor: pointer;
                    flex-shrink: 0;
                  "
                >
                  −
                </ct-button>
                <div style="
                  flex: 1;
                  text-align: center;
                  font-size: 36px;
                  font-weight: 700;
                  color: #92400e;
                ">
                  {left}
                </div>
                <ct-button
                  onClick={incrementLeft({ pair })}
                  style="
                    background: #f59e0b;
                    color: white;
                    border: none;
                    width: 48px;
                    height: 48px;
                    border-radius: 8px;
                    font-size: 24px;
                    font-weight: 700;
                    cursor: pointer;
                    flex-shrink: 0;
                  "
                >
                  +
                </ct-button>
              </div>
              <ct-input
                $value={leftInput}
                onInput={updateFromInputs({ pair, leftInput, rightInput })}
                style="
                  width: 100%;
                  padding: 12px;
                  border: 2px solid #f59e0b;
                  border-radius: 8px;
                  font-size: 16px;
                  text-align: center;
                  font-weight: 600;
                  color: #92400e;
                "
                type="text"
                placeholder="Enter left value"
              />
            </div>

            {/* Right Value */}
            <div style="
              background: #dbeafe;
              border-radius: 12px;
              padding: 20px;
              margin-bottom: 16px;
            ">
              <div style="
                font-size: 12px;
                font-weight: 600;
                color: #1e40af;
                margin-bottom: 12px;
                text-align: center;
              ">
                RIGHT VALUE
              </div>
              <div style="
                display: flex;
                align-items: center;
                gap: 12px;
                margin-bottom: 12px;
              ">
                <ct-button
                  onClick={decrementRight({ pair })}
                  style="
                    background: #3b82f6;
                    color: white;
                    border: none;
                    width: 48px;
                    height: 48px;
                    border-radius: 8px;
                    font-size: 24px;
                    font-weight: 700;
                    cursor: pointer;
                    flex-shrink: 0;
                  "
                >
                  −
                </ct-button>
                <div style="
                  flex: 1;
                  text-align: center;
                  font-size: 36px;
                  font-weight: 700;
                  color: #1e40af;
                ">
                  {right}
                </div>
                <ct-button
                  onClick={incrementRight({ pair })}
                  style="
                    background: #3b82f6;
                    color: white;
                    border: none;
                    width: 48px;
                    height: 48px;
                    border-radius: 8px;
                    font-size: 24px;
                    font-weight: 700;
                    cursor: pointer;
                    flex-shrink: 0;
                  "
                >
                  +
                </ct-button>
              </div>
              <ct-input
                $value={rightInput}
                onInput={updateFromInputs({ pair, leftInput, rightInput })}
                style="
                  width: 100%;
                  padding: 12px;
                  border: 2px solid #3b82f6;
                  border-radius: 8px;
                  font-size: 16px;
                  text-align: center;
                  font-weight: 600;
                  color: #1e40af;
                "
                type="text"
                placeholder="Enter right value"
              />
            </div>

            {/* Tuple Display */}
            <div style="
              background: #f3f4f6;
              border-radius: 8px;
              padding: 16px;
              margin-bottom: 16px;
            ">
              <div style="
                font-size: 12px;
                font-weight: 600;
                color: #6b7280;
                margin-bottom: 8px;
                text-align: center;
              ">
                TUPLE REPRESENTATION
              </div>
              <div style="
                color: #1f2937;
                font-size: 18px;
                font-family: 'SF Mono', 'Monaco', monospace;
                text-align: center;
                font-weight: 600;
              ">
                ({left}, {right})
              </div>
            </div>

            {/* Reset Button */}
            <ct-button
              onClick={resetPair({ pair })}
              style="
                background: #ef4444;
                color: white;
                border: none;
                width: 100%;
                padding: 14px;
                border-radius: 8px;
                font-size: 16px;
                font-weight: 600;
                cursor: pointer;
              "
            >
              Reset to (0, 0)
            </ct-button>
          </div>
        </div>
      ),
    };
  },
);
