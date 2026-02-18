import * as __ctHelpers from "commontools";
import { cell } from "commontools";
export default function TestCollectionsEmpty() {
    // Empty array
    const _emptyArray = cell([], {
        type: "array",
        items: false
    } as const satisfies __ctHelpers.JSONSchema);
    // Empty object
    const _emptyObject = cell({}, {
        type: "object",
        properties: {}
    } as const satisfies __ctHelpers.JSONSchema);
    return {
        emptyArray: _emptyArray,
        emptyObject: _emptyObject,
    };
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
