function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, handler } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
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
    properties: {
        key: {
            type: "string"
        }
    },
    required: ["key"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    additionalProperties: true,
    $comment: "Unsupported intersection pattern: index signature on constituent"
} as const satisfies __cfHelpers.JSONSchema, (event, state) => {
    state.items.get();
    state[event.key];
});
// FIXTURE: unsupported-intersection-index
// Verifies: dynamic key access keeps index-signature intersections open-ended
//   handler<{key:string}, ListState & Indexed>() → context: { additionalProperties: true, $comment: "Unsupported intersection..." }
// Context: negative test -- without the dynamic key read, shrinking can safely
//   keep only `items`. This fixture forces the truly open-ended fallback path.
export { removeItem };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
