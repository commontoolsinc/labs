/// <cts-enable />
import { type Cell, Default, h, handler, recipe, UI } from "commontools";

interface TodoListState {
  items: Default<string[], ["Pay bill", "Write code", "Dinner with friends"]>;
}

const addItem = handler<
  { detail: { message: string } },
  { items: Cell<string[]> }
>(
  (event, { items }) => {
    const value = event.detail.message?.trim();
    if (value) {
      const currentItems = items.get();
      items.set([...currentItems, value]);
    }
  },
);

export default recipe<TodoListState>("Todo List with Default", (state) => {
  return {
    [UI]: (
      <div>
        <h2>My Todos</h2>
        <common-send-message
          name="Add"
          placeholder="Add a todo..."
          onmessagesend={addItem({ items: state.items })}
        />
        <ul>
          {state.items.map((item) => (<li>{item}</li>))}
        </ul>
      </div>
    ),
    items: state.items,
  };
});
