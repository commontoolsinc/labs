/// <cts-enable />
import {
  Cell,
  Default,
  derive,
  h,
  handler,
  NAME,
  recipe,
  Stream,
  UI,
} from "commontools";

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

export default recipe("Simple List", ({ title, items }: InputSchema) => {
  return {
    [NAME]: title,
    [UI]: (
      <div>
        <h3>{title}</h3>
        <p>Super Simple Array</p>
        <ul>
          {items.map((item: Item, index: number) => (
            <li key={index}>{item.text}</li>
          ))}
        </ul>
        <common-send-message
          name="Send"
          placeholder="Type a message..."
          appearance="rounded"
          onmessagesend={addItem({ items })}
        />
      </div>
    ),
    title,
    items,
    addItem: addItem({ items }),
  };
});
