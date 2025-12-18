/// <cts-enable />
import { Cell, Default, handler, NAME, recipe, UI } from "commontools";

interface Item {
  text: Default<string, "">;
}

interface InputSchema {
  title: Default<string, "untitled">;
  items: Default<Item[], []>;
}

type InputEventType = {
  detail: {
    message: string;
  };
};

interface ListState {
  items: Cell<Item[]>;
}

const addItem = handler<InputEventType, ListState>(
  (event: InputEventType, state: ListState) => {
    state.items.push({ text: event.detail.message });
  },
);

export default recipe<InputSchema>(({ title, items }) => {
  return {
    [NAME]: title,
    [UI]: (
      <div>
        <h3>{title}</h3>
        <p>Super Simple Array</p>
        <ul>
          {
            // deno-lint-ignore jsx-key
            items.map((item) => <li>{item.text}</li>)
          }
        </ul>
        <ct-message-input
          name="Send"
          placeholder="Type a message..."
          appearance="rounded"
          onct-send={addItem({ items })}
        />
      </div>
    ),
    title,
    items,
    addItem: addItem({ items }),
  };
});
