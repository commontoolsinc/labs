/// <cts-enable />
import { recipe, h, UI, NAME, toSchema, Cell, Default, handler } from "commontools";

interface Item {
  text: Default<string, "">;
}

interface InputSchemaInterface {
  title: Default<string, "untitled">;
  items: Default<Item[], []>;
}

interface OutputSchemaInterface extends InputSchemaInterface {
  items_count: number;
}

type InputEventType = {
  detail: {
    message: string
  }
};

const inputSchema = toSchema<InputSchemaInterface>();
const outputSchema = toSchema<OutputSchemaInterface>();

// Handler that logs the message event
const addItem = handler
// <
//   { detail: { message: string } },
//   { items: Item[] }
// >
(
  (event: InputEventType, { items }: {items: Cell<Item[]>}) => {
    items.push({text: event.detail.message});
  }
);

export default recipe(inputSchema, outputSchema, ({ title, items }) => {
  const items_count = items.length;
  
  return {
    [NAME]: title,
    [UI]: (
      <div>
        <h3>{title}</h3>
        <p>Basic recipe</p>
        <p>Items count: {items_count}</p>
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
    items_count
  };
});
