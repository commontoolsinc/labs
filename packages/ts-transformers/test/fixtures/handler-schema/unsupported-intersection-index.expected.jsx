import * as __ctHelpers from "commontools";
import { Cell, handler } from "commontools";
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
    type: "unknown"
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    additionalProperties: true,
    $comment: "Unsupported intersection pattern: index signature on constituent"
} as const satisfies __ctHelpers.JSONSchema, (_, { items }) => {
    // noop
    items.get();
});
// FIXTURE: unsupported-intersection-index
// Verifies: intersection with index-signature type falls back to additionalProperties with $comment warning
//   handler<unknown, ListState & Indexed>() → context: { additionalProperties: true, $comment: "Unsupported intersection..." }
// Context: negative test -- index signatures cannot be safely merged, so transformer emits a fallback schema
export { removeItem };
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
