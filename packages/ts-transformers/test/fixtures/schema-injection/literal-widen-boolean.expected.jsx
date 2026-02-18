import * as __ctHelpers from "commontools";
import { cell } from "commontools";
export default function TestLiteralWidenBoolean() {
    const _b1 = cell(true, {
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema);
    const _b2 = cell(false, {
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema);
    return null;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
