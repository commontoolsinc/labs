function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { NAME, OpaqueRef, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
const count: OpaqueRef<number> = {} as any;
const _element = <div>{count}</div>;
// FIXTURE: no-transform-simple-ref
// Verifies: a bare OpaqueRef in JSX ({count}) is NOT wrapped in derive() -- passed through as-is
//   <div>{count}</div> → <div>{count}</div>  (unchanged)
// Context: Negative test -- simple ref interpolation needs no transformation
export default pattern((_state) => {
    return {
        [NAME]: "test",
    };
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string"
        }
    },
    required: ["$NAME"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__ctHardenFn(h);
