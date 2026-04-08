function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { cell } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
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
    } as const satisfies __cfHelpers.JSONSchema);
    const _c2 = cell(variable, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const _c3 = cell(10 + 20, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    return null;
}
__cfHardenFn(TestLiteralWidenMixedValues);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
