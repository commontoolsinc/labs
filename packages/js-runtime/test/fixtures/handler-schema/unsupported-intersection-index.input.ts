/// <cts-enable />
import { handler, Cell } from "commontools";

interface Item { text: string; }
interface ListState { items: Cell<Item[]>; }

// Index signature will prevent safe merge
type Indexed = { [k: string]: unknown };

const removeItem = handler<unknown, ListState & Indexed>(
  (_, { items }) => {
    // noop
    items.get();
  },
);

export { removeItem };
