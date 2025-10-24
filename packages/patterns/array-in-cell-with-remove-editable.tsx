/// <cts-enable />
import { Cell, Default, handler, NAME, OpaqueRef, recipe, UI } from "commontools";

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

const removeItem = handler<
  unknown,
  { items: Cell<Array<Cell<Item>>>; item: Cell<Item> }
>((_event, { items, item }) => {
  const currentItems = items.get();
  const index = currentItems.findIndex((el) => el.equals(item));
  if (index >= 0) {
    items.set(currentItems.toSpliced(index, 1));
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
            {items.map((item: OpaqueRef<Item>) => (
              <div
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
                    $value={item.text}
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
    };
  },
);
