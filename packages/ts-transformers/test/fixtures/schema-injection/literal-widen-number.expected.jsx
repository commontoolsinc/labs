import * as __cfHelpers from "commonfabric";
import { cell } from "commonfabric";
// FIXTURE: literal-widen-number
// Verifies: numeric literals (int, negative, float, scientific, zero) are all widened to { type: "number" }
//   cell(10) → cell(10, { type: "number" })
//   cell(-5) → cell(-5, { type: "number" })
//   cell(3.14) → cell(3.14, { type: "number" })
//   cell(1e10) → cell(1e10, { type: "number" })
//   cell(0) → cell(0, { type: "number" })
export default function TestLiteralWidenNumber() {
    const _n1 = cell(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const _n2 = cell(-5, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const _n3 = cell(3.14, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const _n4 = cell(1e10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const _n5 = cell(0, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    return null;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
