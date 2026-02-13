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

const removeItem = handler<unknown, ListState & { index: number }>(
  (_, { items, index }) => {
    const next = items.get().slice();
    if (index >= 0 && index < next.length) next.splice(index, 1);
    items.set(next);
  },
);

export default pattern<InputSchema>(
  "Simple List with Remove",
  ({ title, items }) => {
    return {
      [NAME]: title,
      [UI]: (
        <div>
          <h3>{title}</h3>
          <p>Super Simple Array with Remove</p>
          <ul>
            {items.map((item, index) => (
              <li key={index}>
                <ct-button
                  variant="destructive"
                  size="sm"
                  onClick={removeItem({ items, index })}
                >
                  Remove
                </ct-button>{" "}
                <span>{item.text}</span>
              </li>
            ))}
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
  },
);
