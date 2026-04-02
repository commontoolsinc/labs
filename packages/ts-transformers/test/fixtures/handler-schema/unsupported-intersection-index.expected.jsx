function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { Cell, handler } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
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
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    additionalProperties: true,
    $comment: "Unsupported intersection pattern: index signature on constituent"
} as const satisfies __cfHelpers.JSONSchema, (_, { items }) => {
    // noop
    items.get();
});
// FIXTURE: unsupported-intersection-index
// Verifies: intersection with index-signature type falls back to additionalProperties with $comment warning
//   handler<unknown, ListState & Indexed>() → context: { additionalProperties: true, $comment: "Unsupported intersection..." }
// Context: negative test -- index signatures cannot be safely merged, so transformer emits a fallback schema
export { removeItem };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__ctHardenFn(h);
