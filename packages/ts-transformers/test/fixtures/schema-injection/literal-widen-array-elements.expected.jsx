import * as __ctHelpers from "commontools";
import { cell } from "commontools";
export default function TestLiteralWidenArrayElements() {
    const _arr1 = cell([1, 2, 3], {
        type: "array",
        items: {
            type: "number"
        }
    } as const satisfies __ctHelpers.JSONSchema);
    const _arr2 = cell(["a", "b", "c"], {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __ctHelpers.JSONSchema);
    const _arr3 = cell([true, false], {
        type: "array",
        items: {
            type: "boolean"
        }
    } as const satisfies __ctHelpers.JSONSchema);
    return null;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
