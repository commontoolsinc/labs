/// <cts-enable />
import { handler, recipe, UI } from "commontools";

type TodoState = {
  items: string[];
};

type TodoEvent = {
  add: string;
};

const addTodo = handler<TodoEvent, { items: string[] }>((event, state) => {
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
