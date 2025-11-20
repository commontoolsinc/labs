/// <cts-enable />
import { Cell, handler, recipe, UI } from "commontools";

type TodoState = {
  items: Cell<string[]>;
};

type TodoEvent = {
  add: string;
};

const addTodo = handler<TodoEvent, { items: Cell<string[]> }>((event, state) => {
  state.items.push(event.add);
});

export default recipe<TodoState>((state) => {
  return {
    [UI]: (
      <div>
        <button
          type="button"
          onClick={addTodo({ items: state.items })}
        >
          Add
        </button>
        <ul>
          {state.items.map((item) => <li key={item}>{item}</li>)}
        </ul>
      </div>
    ),
  };
});
