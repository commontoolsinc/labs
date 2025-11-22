import * as __ctHelpers from "commontools";
import { cell } from "commontools";
export default function TestLiteralWidenBigInt() {
    const _bi1 = cell(123n, {
        type: "integer"
    } as const satisfies __ctHelpers.JSONSchema);
    const _bi2 = cell(0n, {
        type: "integer"
    } as const satisfies __ctHelpers.JSONSchema);
    const _bi3 = cell(-456n, {
        type: "integer"
    } as const satisfies __ctHelpers.JSONSchema);
    return null;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
