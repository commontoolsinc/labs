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

const removeItem = handler<unknown, { items: Cell<Item[]>; index: number }>(
  (_, { items, index }) => {
    const itemsCopy = items.get().slice();
    if (index >= 0 && index < itemsCopy.length) itemsCopy.splice(index, 1);
    items.set(itemsCopy);
  },
);

const updateItem = handler<
  { detail: { value: string } },
  { items: Cell<Item[]>; index: number }
>(({ detail: { value } }, { items, index }) => {
  const itemsCopy = items.get().slice();
  if (index >= 0 && index < itemsCopy.length) {
    itemsCopy[index] = { text: value };
    items.set(itemsCopy);
  }
});

export default recipe(
  "Simple List with Remove and Edit",
  ({ title, items }: InputSchema) => {
    return {
      [NAME]: title,
      [UI]: (
        <div style={{ padding: "1rem", maxWidth: "600px" }}>
          <h3>{title}</h3>
          <p>Editable Array with Remove</p>
          <div
            style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
          >
            {items.map((item: Item, index: number) => (
              <div
                key={index}
                style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
              >
                <ct-button
                  variant="destructive"
                  size="sm"
                  onClick={removeItem({ items, index })}
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
            <common-send-message
              name="Send"
              placeholder="Type a message..."
              appearance="rounded"
              onmessagesend={addItem({ items })}
            />
          </div>
        </div>
      ),
      title,
      items,
      addItem: addItem({ items }),
      updateItem,
    };
  },
);
