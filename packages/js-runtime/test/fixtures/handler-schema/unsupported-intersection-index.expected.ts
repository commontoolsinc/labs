/// <cts-enable />
import { handler, Cell, JSONSchema } from "commontools";
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
const removeItem = handler({
    type: "object",
    additionalProperties: true
} as const satisfies JSONSchema, {
    type: "object",
    additionalProperties: true,
    $comment: "Unsupported intersection pattern: index signature on constituent"
} as const satisfies JSONSchema, (_, { items }) => {
    // noop
    items.get();
});
export { removeItem };


