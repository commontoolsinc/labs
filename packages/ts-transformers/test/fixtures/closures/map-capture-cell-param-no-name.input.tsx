/// <cts-enable />
import { Cell, Default, handler, pattern, UI } from "commontools";

interface Item {
  text: Default<string, "">;
}

interface InputSchema {
  items: Default<Item[], []>;
}

const removeItem = handler<unknown, { items: Cell<Item[]>; index: number }>(
  (_, _2) => {
    // Not relevant for repro
  },
);

export default pattern(
  ({ items }: InputSchema) => {
    return {
      [UI]: (
        <ul>
          {items.map((_, index) => (
            <li key={index}>
              <ct-button onClick={removeItem({ items, index })}>
                Remove
              </ct-button>
            </li>
          ))}
        </ul>
      ),
    };
  },
);
