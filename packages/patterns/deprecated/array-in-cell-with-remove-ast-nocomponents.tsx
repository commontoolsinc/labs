import { Default, handler, NAME, pattern, UI, Writable } from "commonfabric";

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
                <cf-button
                  variant="destructive"
                  size="sm"
                  onClick={removeItem({ items, index })}
                >
                  Remove
                </cf-button>{" "}
                <span>{item.text}</span>
              </li>
            ))}
          </ul>
          <cf-message-input
            name="Send"
            placeholder="Type a message..."
            appearance="rounded"
            oncf-send={addItem({ items })}
          />
        </div>
      ),
      title,
      items,
      addItem: addItem({ items }),
    };
  },
);
