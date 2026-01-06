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

const removeItem = handler<
  unknown,
  { items: Writable<Array<Writable<Item>>>; item: Writable<Item> }
>((_event, { items, item }) => {
  const currentItems = items.get();
  const index = currentItems.findIndex((el) => el.equals(item));
  if (index >= 0) {
    items.set(currentItems.toSpliced(index, 1));
  }
});

const updateItem = handler<
  { detail: { value: string } },
  { items: Writable<Item[]>; index: number }
>(({ detail: { value } }, { items, index }) => {
  const itemsCopy = items.get().slice();
  if (index >= 0 && index < itemsCopy.length) {
    itemsCopy[index] = { text: value };
    items.set(itemsCopy);
  }
});

export default pattern<InputSchema>(({ title, items }) => {
  return {
    [NAME]: title,
    [UI]: (
      <div style={{ padding: "1rem", maxWidth: "600px" }}>
        <h3>{title}</h3>
        <p>Editable Array with Remove</p>
        <div
          style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
        >
          {items.map((item, index) => (
            <div
              key={index}
              style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
            >
              <ct-button
                variant="destructive"
                size="sm"
                onClick={removeItem({ items, item })}
              >
                Remove
              </ct-button>
              <div style={{ flex: 1 }}>
                <ct-input
                  value={item.text}
                  onct-change={updateItem({ items, index })}
                  placeholder="Enter text..."
                />
              </div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: "1rem" }}>
          <ct-message-input
            name="Send"
            placeholder="Type a message..."
            appearance="rounded"
            onct-send={addItem({ items })}
          />
        </div>
      </div>
    ),
    title,
    items,
    addItem: addItem({ items }),
    updateItem,
  };
});
