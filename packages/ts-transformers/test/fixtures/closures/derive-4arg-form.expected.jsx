function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { Writable, derive, pattern, type JSONSchema } from "commonfabric";
import "commonfabric/schema";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
// FIXTURE: derive-4arg-form
// Verifies: closure extraction works with explicit 4-arg derive(inputSchema, outputSchema, input, fn)
//   derive(schema, schema, value, fn) → derive(mergedSchema, schema, { value, multiplier }, fn)
// Context: `multiplier` is captured even though schemas are already provided
export default pattern(() => {
    const value = Writable.of(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const multiplier = Writable.of(2, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    // Explicit 4-arg form with schemas - should still transform captures
    const result = __cfHelpers.derive({
        type: "object",
        properties: {
            value: {
                type: "number",
                asCell: true
            },
            multiplier: {
                type: "number",
                asCell: true
            }
        },
        required: ["value", "multiplier"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {
        value,
        multiplier: multiplier
    }, ({ value: v, multiplier }) => v.get() * multiplier.get());
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__ctHardenFn(h);
