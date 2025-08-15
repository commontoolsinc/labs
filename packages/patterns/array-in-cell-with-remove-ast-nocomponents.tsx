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

// Should be imported, once we have types for all events
type InputEventType = {
  detail: {
    message: string;
  };
};

const addItem = handler(
  (event: InputEventType, { items }: {
    items: Cell<Item[]>;
  }) => {
    items.push({ text: event.detail.message });
  },
);

const removeItem = handler(
  (_, { items, index }: { items: Cell<Item[]>; index: number }) => {
    const next = items.get().slice();
    if (index >= 0 && index < next.length) next.splice(index, 1);
    items.set(next);
  },
);

export default recipe<{
  title: Default<string, "untitled">;
  items: Default<Item[], []>;
}>(
  "Simple List with Remove",
  ({ title, items }) => {
    return {
      [NAME]: title,
      [UI]: (
        <div>
          <h3>{title}</h3>
          <p>Super Simple Array with Remove</p>
          <ul>
            {items.map((item: Item, index: number) => (
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
  },
);
