/// <cts-enable />
import { type Cell, Default, handler, pattern, UI } from "commontools";

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

export default pattern<TodoListState>("Todo List with Default", (state) => {
  return {
    [UI]: (
      <div>
        <h2>My Todos</h2>
        <ct-message-input
          name="Add"
          placeholder="Add a todo..."
          onct-send={addItem({ items: state.items })}
        />
        <ul>
          {/* Note: key is not needed for Common Tools but linters require it */}
          {state.items.map((item, index) => <li key={index}>{item}</li>)}
        </ul>
      </div>
    ),
    items: state.items,
  };
});
