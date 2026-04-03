import * as __ctHelpers from "commontools";
import { cell } from "commontools";
// FIXTURE: literal-widen-mixed-values
// Verifies: schema injection works for literals, variable references, and expressions alike
//   cell(10) → cell(10, { type: "number" })
//   cell(variable) → cell(variable, { type: "number" })
//   cell(10 + 20) → cell(10 + 20, { type: "number" })
// Context: variable and expression values are resolved to their inferred type
export default function TestLiteralWidenMixedValues() {
    const variable = 42;
    const _c1 = cell(10, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const _c2 = cell(variable, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const _c3 = cell(10 + 20, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    return null;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
