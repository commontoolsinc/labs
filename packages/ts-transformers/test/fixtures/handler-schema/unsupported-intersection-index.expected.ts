import * as __ctHelpers from "commontools";
import { handler, Cell } from "commontools";
interface Item {
    text: string;
}
interface ListState {
    items: Cell<Item[]>;
}
// Index signature will prevent safe merge
type Indexed = {
    [k: string]: unknown;
};
const removeItem = handler(true as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    additionalProperties: true,
    $comment: "Unsupported intersection pattern: index signature on constituent"
} as const satisfies __ctHelpers.JSONSchema, (_, { items }) => {
    // noop
    items.get();
});
export { removeItem };
__ctHelpers.NAME; // <internals>
