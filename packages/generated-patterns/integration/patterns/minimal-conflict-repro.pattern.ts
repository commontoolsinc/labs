/// <cts-enable />
import { type Cell, cell, Default, handler, lift, recipe } from "commontools";

interface Item {
  id?: string;
}

const action = handler(
  (_event, context: { items: Cell<Item[]>; sequence: Cell<number> }) => {
    // Minimal repro: Removing either of these removes the conflict
    context.items.set([]);
    context.sequence.set(context.sequence.get() + 1);
  },
);

export const conflictRepro = recipe<{ items: Default<Item[], []> }>(
  ({ items }) => {
    const sequence = cell(0);

    // Minimal repro: Removing the lift and the map removes the conflict
    lift((item: Item[]) => item.map((_) => ({})))(items);

    return {
      action: action({
        items,
        sequence,
      }),
    };
  },
);
