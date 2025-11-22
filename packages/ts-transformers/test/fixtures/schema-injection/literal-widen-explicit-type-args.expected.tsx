import * as __ctHelpers from "commontools";
import { Cell } from "commontools";
export default function TestLiteralWidenExplicitTypeArgs() {
    const _c1 = Cell.of<number>(10, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const _c2 = Cell.of<string>("hello", {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema);
    const _c3 = Cell.of<boolean>(true, {
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema);
    return null;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
