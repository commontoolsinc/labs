/// <cts-enable />
import { Cell, derive, handler, ifElse, recipe, UI } from "commontools";

interface Item {
  id: string;
}

interface State {
  items: Cell<Array<Cell<Item>>>;
}

const removeItem = handler<unknown, { items: Cell<Array<Cell<Item>>>; item: Cell<Item> }>(
  (_event, { items, item }) => {
    const currentItems = items.get();
    const index = currentItems.findIndex((el) => item.equals(el));
    if (index >= 0) {
      items.set(currentItems.toSpliced(index, 1));
    }
  }
);

export default recipe<State>("HandlerIfElseMap", (state) => {
  const hasItems = derive(state.items, (items) => items.get().length > 0);
  
  return {
    [UI]: ifElse(
      hasItems,
      <div>
        {state.items.map((item) => (
          <button type="button" onClick={removeItem({ items: state.items, item })}>
            Remove
          </button>
        ))}
      </div>,
      <div>No items</div>
    ),
  };
});
