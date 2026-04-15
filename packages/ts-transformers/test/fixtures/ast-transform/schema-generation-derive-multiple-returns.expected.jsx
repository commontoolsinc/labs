function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { derive } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
declare const flag: boolean;
// FIXTURE: schema-generation-derive-multiple-returns
// Verifies: derive() with multiple return paths infers a union output schema
//   derive(flag, fn) → derive({ type: "boolean" }, { enum: ["hello", 42] }, flag, fn)
// Context: Callback has two return statements (string and number); output schema is an enum union
// Function with multiple return statements - should infer string | number
export const multiReturn = __cfHelpers.__cf_data(derive({
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, {
    "enum": ["hello", 42]
} as const satisfies __cfHelpers.JSONSchema, flag, (value) => {
    if (value) {
        return "hello";
    }
    return 42;
}).for("multiReturn", true));
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
