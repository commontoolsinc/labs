import { Cell, handler } from "commonfabric";

interface Item {
  text: string;
}
interface ListState {
  items: Cell<Item[]>;
}

// Index signature will prevent safe merge
type Indexed = { [k: string]: unknown };

const removeItem = handler<{ key: string }, ListState & Indexed>(
  (event, state) => {
    state.items.get();
    state[event.key];
  },
);

// FIXTURE: unsupported-intersection-index
// Verifies: dynamic key access keeps index-signature intersections open-ended
//   handler<{key:string}, ListState & Indexed>() → context: { additionalProperties: true, $comment: "Unsupported intersection..." }
// Context: negative test -- without the dynamic key read, shrinking can safely
//   keep only `items`. This fixture forces the truly open-ended fallback path.
export { removeItem };
