import * as __cfHelpers from "commonfabric";
import { cell } from "commonfabric";
// FIXTURE: literal-widen-string
// Verifies: string literals (normal, empty, multiline, with spaces) are all widened to { type: "string" }
//   cell("hello") → cell("hello", { type: "string" })
//   cell("") → cell("", { type: "string" })
//   cell("hello\nworld") → cell("hello\nworld", { type: "string" })
export default function TestLiteralWidenString() {
    const _s1 = cell("hello", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema);
    const _s2 = cell("", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema);
    const _s3 = cell("hello\nworld", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema);
    const _s4 = cell("with spaces", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema);
    return null;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
