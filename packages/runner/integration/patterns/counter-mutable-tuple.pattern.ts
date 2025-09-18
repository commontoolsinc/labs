/// <cts-enable />
import { Cell, compute, handler, lift, recipe, str } from "commontools";

interface MutableTupleArgs {
  pair?: [number, number];
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
    pair.setDefault([0, 0]);

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

    return {
      pair,
      tuple,
      left,
      right,
      sum,
      label,
      set: setPair({ pair }),
      adjust: adjustPair({ pair }),
      effects: { initialize },
    };
  },
);
