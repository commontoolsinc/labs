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
__cfHardenFn(TestLiteralWidenBoolean);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
