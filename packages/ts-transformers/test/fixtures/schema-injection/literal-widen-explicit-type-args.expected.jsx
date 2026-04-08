function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: literal-widen-explicit-type-args
// Verifies: Cell.of with explicit type arguments injects schema matching the type arg
//   Cell.of<number>(10) → Cell.of<number>(10, { type: "number" })
//   Cell.of<string>("hello") → Cell.of<string>("hello", { type: "string" })
//   Cell.of<boolean>(true) → Cell.of<boolean>(true, { type: "boolean" })
export default function TestLiteralWidenExplicitTypeArgs() {
    const _c1 = Cell.of<number>(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const _c2 = Cell.of<string>("hello", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema);
    const _c3 = Cell.of<boolean>(true, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema);
    return null;
}
__cfHardenFn(TestLiteralWidenExplicitTypeArgs);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
