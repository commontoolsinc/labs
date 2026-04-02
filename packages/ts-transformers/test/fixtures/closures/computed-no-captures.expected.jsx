function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { computed, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
// FIXTURE: computed-no-captures
// Verifies: computed(() => expr) with no external captures is transformed to derive() with empty captures
//   computed(() => 42) → derive({ type: "object", properties: {} }, resultSchema, {}, () => 42)
// Context: The capture schema has no properties and the captures object is empty {}.
//   The callback parameter list is also empty (no destructuring needed).
export default pattern(() => {
    const result = __cfHelpers.derive({
        type: "object",
        properties: {}
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {}, () => 42);
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__ctHardenFn(h);
