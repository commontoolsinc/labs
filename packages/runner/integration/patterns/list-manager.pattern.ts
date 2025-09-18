/// <cts-enable />
import { Cell, Default, derive, handler, lift, recipe, str } from "commontools";

interface Item {
  label: string;
  count: number;
}

interface ListManagerArgs {
  items: Default<Item[], []>;
}

const addItem = handler(
  (
    event: { label?: string; count?: number } | undefined,
    context: { items: Cell<Item[]> },
  ) => {
    const label = event?.label ?? "untitled";
    const count = typeof event?.count === "number" ? event.count : 0;
    context.items.push({ label, count });
  },
);

const incrementItem = handler(
  (
    event: { index?: number; amount?: number } | undefined,
    context: { items: Cell<Item[]> },
  ) => {
    const index = event?.index ?? 0;
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const target = context.items.key(index) as Cell<Item>;
    const countCell = target.key("count");
    const current = countCell.get() ?? 0;
    countCell.set(current + amount);
  },
);

export const listManager = recipe<ListManagerArgs>(
  "List Manager",
  ({ items }) => {
    const size = lift((collection: Item[]) => collection.length)(items);
    const names = derive(
      items,
      (collection) => collection.map((item) => item.label),
    );

    return {
      summary: str`Items: ${size}`,
      items,
      names,
      controls: {
        add: addItem({ items }),
        increment: incrementItem({ items }),
      },
    };
  },
);
