import * as __cfHelpers from "commonfabric";
import { cell } from "commonfabric";
// FIXTURE: literal-widen-bigint
// Verifies: bigint literals are widened to { type: "integer" } schema
//   cell(123n) → cell(123n, { type: "integer" })
//   cell(0n) → cell(0n, { type: "integer" })
//   cell(-456n) → cell(-456n, { type: "integer" })
export default function TestLiteralWidenBigInt() {
    const _bi1 = cell(123n, {
        type: "integer"
    } as const satisfies __cfHelpers.JSONSchema);
    const _bi2 = cell(0n, {
        type: "integer"
    } as const satisfies __cfHelpers.JSONSchema);
    const _bi3 = cell(-456n, {
        type: "integer"
    } as const satisfies __cfHelpers.JSONSchema);
    return null;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
