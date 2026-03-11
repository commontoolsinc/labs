import * as __ctHelpers from "commontools";
import { cell } from "commontools";
// FIXTURE: literal-widen-null-undefined
// Verifies: null and undefined literals produce their respective type schemas
//   cell(null) → cell(null, { type: "null" })
//   cell(undefined) → cell(undefined, { type: "undefined" })
export default function TestLiteralWidenNullUndefined() {
    const _c1 = cell(null, {
        type: "null"
    } as const satisfies __ctHelpers.JSONSchema);
    const _c2 = cell(undefined, {
        type: "undefined"
    } as const satisfies __ctHelpers.JSONSchema);
    return null;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
