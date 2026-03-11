import * as __ctHelpers from "commontools";
import { computed, pattern } from "commontools";
export default pattern(() => {
    const result = __ctHelpers.derive({
        type: "object",
        properties: {}
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {}, () => 42);
    return result;
}, false as const satisfies __ctHelpers.JSONSchema, {
    type: "number",
    asOpaque: true
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
