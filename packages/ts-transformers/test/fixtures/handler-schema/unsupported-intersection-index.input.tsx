import { Cell, handler } from "commonfabric";

interface Item {
  text: string;
}
interface ListState {
  items: Cell<Item[]>;
}

// Index signature will prevent safe merge
type Indexed = { [k: string]: unknown };

const removeItem = handler<unknown, ListState & Indexed>(
  (_, { items }) => {
    // noop
    items.get();
  },
);

// FIXTURE: unsupported-intersection-index
// Verifies: intersection with index-signature type falls back to additionalProperties with $comment warning
//   handler<unknown, ListState & Indexed>() → context: { additionalProperties: true, $comment: "Unsupported intersection..." }
// Context: negative test -- index signatures cannot be safely merged, so transformer emits a fallback schema
export { removeItem };
