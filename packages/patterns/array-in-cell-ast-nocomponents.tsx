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

const addItem = handler(
  (event: { detail: { message: string } }, { items }: {
    items: Cell<Item[]>;
  }) => {
    items.push({ text: event.detail.message });
  },
);

export default recipe<{
  title: Default<string, "untitled">;
  items: Default<Item[], []>;
}>("Simple List", ({ title, items }) => {
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
