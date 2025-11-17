import * as __ctHelpers from "commontools";
import { computed } from "commontools";
export default function TestComputeNoCaptures() {
    const result = __ctHelpers.derive({
        type: "object",
        properties: {}
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {}, () => 42);
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
