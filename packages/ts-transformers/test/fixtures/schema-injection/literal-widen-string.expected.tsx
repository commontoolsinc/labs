import * as __ctHelpers from "commontools";
import { cell } from "commontools";
export default function TestLiteralWidenString() {
    const _s1 = cell("hello", {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema);
    const _s2 = cell("", {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema);
    const _s3 = cell("hello\nworld", {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema);
    const _s4 = cell("with spaces", {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema);
    return null;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
