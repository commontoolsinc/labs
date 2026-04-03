import * as __ctHelpers from "commontools";
import { cell } from "commontools";
// FIXTURE: literal-widen-bigint
// Verifies: bigint literals are widened to { type: "integer" } schema
//   cell(123n) → cell(123n, { type: "integer" })
//   cell(0n) → cell(0n, { type: "integer" })
//   cell(-456n) → cell(-456n, { type: "integer" })
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
