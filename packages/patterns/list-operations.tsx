/// <cts-enable />
import {
  Cell,
  Default,
  derive,
  handler,
  ID,
  lift,
  NAME,
  recipe,
  UI,
} from "commontools";

// NOTE: This example uses [ID] to demonstrate advanced array manipulation features
// and ensure stable references when items are inserted/removed at the front of the array.
// For most basic list patterns, you DON'T need [ID] - see shopping-list.tsx for a
// simpler example without [ID].
interface Item {
  [ID]: number;
  title: string;
}

interface ListInput {
  items: Default<Item[], []>;
}

interface ListOutput extends ListInput {}

const typeTest = handler(
  (
    _,
    state: {
      a: Cell<Item[]>;
      b: readonly Item[];
      c: readonly Cell<Item>[];
      d: Cell<Cell<Item>[]>;
    },
  ) => {
    const { a, b, c, d } = state;
    console.log({ a, b, c, d });
  },
);

const resetList = handler((_, state: { items: Cell<Item[]> }) => {
  state.items.set([{ [ID]: 1, title: "A" }, { [ID]: 2, title: "B" }, {
    [ID]: 3,
    title: "C",
  }, { [ID]: 4, title: "D" }]);
});

const deleteFirstItem = handler((_, state: { items: Cell<Item[]> }) => {
  state.items.set(state.items.get().slice(1));
});

const deleteLastItem = handler((_, state: { items: Cell<Item[]> }) => {
  const currentItems = state.items.get();
  state.items.set(currentItems.slice(0, -1));
});

const deleteAllItems = handler((_, state: { items: Cell<Item[]> }) => {
  state.items.set([]);
});

const insertItemAtStart = handler((_, state: { items: Cell<Item[]> }) => {
  const currentItems = state.items.get();
  state.items.set([
    { [ID]: Math.random(), title: "New Start" },
    ...currentItems,
  ]);
});

const insertItemAtEnd = handler((_, state: { items: Cell<Item[]> }) => {
  const currentItems = state.items.get();
  state.items.set([...currentItems, { [ID]: Math.random(), title: "New End" }]);
});

const shuffleItems = handler((_, state: { items: Cell<Item[]> }) => {
  const currentItems = state.items.get();
  const shuffled = [...currentItems].sort(() => Math.random() - 0.5);
  state.items.set(shuffled);
});

const show = lift((items: Item[]) => {
  return `${
    items.filter((item) => item && item.title).map((item) => item.title).join(
      ", ",
    )
  } (${items.length})`;
});

export default recipe<ListInput, ListOutput>(
  "list operations",
  ({ items }) => {
    const lowerCase = derive(
      items,
      (items) => items.map((item) => item.title.toLowerCase()),
    );
    // const lowerCase = items.map((item) => item.title.toLowerCase()); // fails with 'TypeError: item.title.toLowerCase is not a function'

    // We do not just have top-level support on Cell<T[]> for the major array operations.
    // However, performing them on a ProxyObject (such as within a derive, or calling .get() on a Cell in a handler) will work as expected.
    // caveat: behaviour is only guaranteed to be correct for all operations IF the items include an [ID] property.
    // excluding the [ID] in this recipe leads to item alignment bugs when insertig or removing from items at the FRONT of an array
    const itemsLessThanB = derive(
      items,
      (items) => items.filter((item) => item.title < "B"),
    );
    const extendedItems = derive(
      items,
      (items) =>
        items.concat([
          { [ID]: 5, title: "E" },
          { [ID]: 6, title: "F" },
        ]),
    );
    const combinedItems = derive(
      items,
      (items) =>
        items.reduce((acc: string, item: Item) => acc += item.title, ""),
    );

    // Notice that you can bind the same cell to many types
    const _x = typeTest({ a: items, b: items, c: items, d: items });

    return {
      [NAME]: "List demo",
      [UI]: (
        <common-vstack gap="md">
          <ct-card>
            <ct-button
              id="reset-demo"
              onClick={resetList({ items })}
            >
              Reset Demo
            </ct-button>

            <ct-button
              id="delete-first"
              onClick={deleteFirstItem({ items })}
            >
              Delete First Item
            </ct-button>

            <ct-button
              id="delete-last"
              onClick={deleteLastItem({ items })}
            >
              Delete Last Item
            </ct-button>

            <ct-button
              id="delete-all"
              onClick={deleteAllItems({ items })}
            >
              Delete All Items
            </ct-button>

            <ct-button
              id="insert-start"
              onClick={insertItemAtStart({ items })}
            >
              Insert Item at Start
            </ct-button>

            <ct-button
              id="insert-end"
              onClick={insertItemAtEnd({ items })}
            >
              Insert Item at End
            </ct-button>

            <ct-button
              id="shuffle"
              onClick={shuffleItems({ items })}
            >
              Shuffle Items
            </ct-button>

            <pre id="main-list">{show(items)}</pre>
            <pre id="lowercase-list">{lowerCase}</pre>
            <pre id="filtered-list">{show(itemsLessThanB)}</pre>
            <pre id="extended-list">{show(extendedItems)}</pre>
            <pre id="combined-list">{combinedItems}</pre>
          </ct-card>
        </common-vstack>
      ),
      items,
    };
  },
);
