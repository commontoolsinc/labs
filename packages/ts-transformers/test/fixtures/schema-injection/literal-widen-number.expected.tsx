import * as __ctHelpers from "commontools";
import { cell } from "commontools";
export default function TestLiteralWidenNumber() {
    const n1 = cell(10, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const n2 = cell(-5, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const n3 = cell(3.14, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const n4 = cell(1e10, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const n5 = cell(0, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    return null;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
