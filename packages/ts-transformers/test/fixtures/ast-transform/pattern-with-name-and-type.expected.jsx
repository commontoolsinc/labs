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
interface MyInput {
    value: number;
}
// FIXTURE: pattern-with-name-and-type
// Verifies: pattern with inline typed parameter generates input and output schemas
//   pattern((input: MyInput) => ...)   → pattern((input) => ..., inputSchema, outputSchema)
//   input.value                        → input.key("value")
// Context: Type comes from inline parameter annotation, not generic type argument
export default pattern((input: MyInput) => {
    return {
        result: __cfHelpers.derive({
            type: "object",
            properties: {
                input: {
                    type: "object",
                    properties: {
                        value: {
                            type: "number"
                        }
                    },
                    required: ["value"]
                }
            },
            required: ["input"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { input: {
                value: input.key("value")
            } }, ({ input: input_1 }) => input.value * 2),
    };
}, {
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        result: {
            type: "number"
        }
    },
    required: ["result"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__ctHardenFn(h);
