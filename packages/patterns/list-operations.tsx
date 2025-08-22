/// <cts-enable />
import {
  Cell,
  Default,
  h,
  handler,
  NAME,
  derive,
  str,
  Opaque,
  recipe,
  lift,
  toSchema,
  ID,
  UI,
} from "commontools";

interface Item {
  [ID]: number;
  title: string;
}

interface ListInput {
  items: Default<Item[], []>;
}

interface ListOutput extends ListInput {}

const resetList = handler((_, state: { items: Cell<Item[]> }) => {
  state.items.set([{ [ID]: Math.random(), title: "A" }, { [ID]: Math.random(), title: "B" }, { [ID]: Math.random(), title: "C" }, { [ID]: Math.random(), title: "D" }]);
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
  state.items.set([{ [ID]: Math.random(), title: "New Start" }, ...currentItems]);
});

const insertItemAtEnd = handler((_, state: { items: Cell<Item[]> }) => {
  const currentItems = state.items.get();
  state.items.set([...currentItems, { [ID]: Math.random(),title: "New End" }]);
});

const shuffleItems = handler((_, state: { items: Cell<Item[]> }) => {
  const currentItems = state.items.get();
  const shuffled = [...currentItems].sort(() => Math.random() - 0.5);
  state.items.set(shuffled);
});

function printList(items: Item[]) {
  return `${items.map((item) => item.title).join(", ")} (${items.length})`;
}

export default recipe<ListInput, ListOutput>(
  "list operations",
  ({ items }) => {

    const lowerCase = derive(items, items => items.map((item) => item.title.toLowerCase()));
    // const lowerCase = items.map((item) => item.title.toLowerCase()); // fails with 'TypeError: item.title.toLowerCase is not a function'

    // We do not just have top-level support on Cell<T[]> for the major array operations.
    // However, performing them on a ProxyObject (such as within a derive, or calling .get() on a Cell in a handler) will work as expected.
    // caveat: behaviour is only guaranteed to be correct for all operations IF the items include an [ID] property.
      // excluding the [ID] in this recipe leads to item alignment bugs when insertig or removing from items at the FRONT of an array
    const itemsLessThanB = derive(items, (items) => items.filter((item) => item.title < "B"));
    const extendedItems = derive(items, (items) => items.concat([{ [ID]: Math.random(), title: "E" }, { [ID]: Math.random(), title: "F" }]));
    const combinedItems = derive(items, (items) => items.reduce((acc: string, item: Item) => acc += item.title, ''));

    // A good use of lift() is to avoid repeatedly writing derive() inline in the JSX
    const show = lift(printList);

    return {
      [NAME]: title,
      [UI]: (
        <common-vstack gap="md">
          <ct-card>
            <ct-button
              onClick={resetList({ items })}
            >
              Reset Demo
            </ct-button>

            <ct-button
              onClick={deleteFirstItem({ items })}
            >
              Delete First Item
            </ct-button>

            <ct-button
              onClick={deleteLastItem({ items })}
            >
              Delete Last Item
            </ct-button>

            <ct-button
              onClick={deleteAllItems({ items })}
            >
              Delete All Items
            </ct-button>

            <ct-button
              onClick={insertItemAtStart({ items })}
            >
              Insert Item at Start
            </ct-button>

            <ct-button
              onClick={insertItemAtEnd({ items })}
            >
              Insert Item at End
            </ct-button>

            <ct-button
              onClick={shuffleItems({ items })}
            >
              Shuffle Items
            </ct-button>


            <pre>{show(items)}</pre>
            <pre>{lowerCase}</pre>
            <pre>{show(itemsLessThanB)}</pre>
            <pre>{show(extendedItems)}</pre>
            <pre>{combinedItems}</pre>
          </ct-card>
        </common-vstack>
      ),
      title,
      items,
    };
  },
);
