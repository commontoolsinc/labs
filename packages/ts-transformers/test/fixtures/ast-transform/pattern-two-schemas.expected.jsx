function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { computed, pattern, type JSONSchema } from "commonfabric";
import "commonfabric/schema";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
// Test that pattern with both schemas already present is not transformed
interface Input {
    count: number;
}
interface Result {
    doubled: number;
}
// FIXTURE: pattern-two-schemas
// Verifies: pattern with both input and output schemas already present preserves them
//   pattern<Input, Result>(fn, inputSchema, outputSchema) → pattern(fn, inputSchema, outputSchema) (schemas kept)
//   ({ count }) destructuring                              → __ct_pattern_input.key("count")
// Context: Schemas are user-provided, not generated; type args are stripped but schemas remain
export default pattern((__ct_pattern_input) => {
    const count = __ct_pattern_input.key("count");
    return {
        doubled: __cfHelpers.derive({
            type: "object",
            properties: {
                count: {
                    type: "number"
                }
            },
            required: ["count"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { count: count }, ({ count }) => count * 2)
    };
}, {
    type: "object",
    properties: {
        count: {
            type: "number"
        }
    },
    required: ["count"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        doubled: {
            type: "number"
        }
    },
    required: ["doubled"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__ctHardenFn(h);
