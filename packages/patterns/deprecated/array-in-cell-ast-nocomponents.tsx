/// <cts-enable />
import { Default, handler, NAME, pattern, UI, Writable } from "commontools";

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
  items: Writable<Item[]>;
}

const addItem = handler<InputEventType, ListState>(
  (event: InputEventType, state: ListState) => {
    state.items.push({ text: event.detail.message });
  },
);

export default pattern<InputSchema>(({ title, items }) => {
  return {
    [NAME]: title,
    [UI]: (
      <div>
        <h3>{title}</h3>
        <p>Super Simple Array</p>
        <ul>
          {items.map((item) => <li>{item.text}</li>)}
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
