import * as __cfHelpers from "commonfabric";
import { cell } from "commonfabric";
// FIXTURE: literal-widen-boolean
// Verifies: boolean literals (true/false) are widened to { type: "boolean" } schema
//   cell(true) → cell(true, { type: "boolean" })
//   cell(false) → cell(false, { type: "boolean" })
export default function TestLiteralWidenBoolean() {
    const _b1 = cell(true, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema);
    const _b2 = cell(false, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema);
    return null;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
