function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, pattern, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Input {
    foo: string;
}
interface Output extends Input {
    bar: number;
}
// FIXTURE: pattern-explicit-types
// Verifies: explicit Input and Output type parameters generate separate input/output schemas
//   pattern<Input, Output>() → input schema from Input, output schema from Output (includes inherited fields)
//   Output extends Input → output schema includes both own (bar) and inherited (foo) properties
export default pattern((input) => {
    return __cfHelpers.derive({
        type: "object",
        properties: {
            input: {
                type: "object",
                properties: {
                    foo: {
                        type: "string"
                    }
                },
                required: ["foo"]
            }
        },
        required: ["input"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "object",
        properties: {
            bar: {
                type: "number"
            },
            foo: {
                type: "string"
            }
        },
        required: ["bar", "foo"]
    } as const satisfies __cfHelpers.JSONSchema, { input: input }, ({ input: input_1 }) => ({ ...input, bar: 123 })).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        foo: {
            type: "string"
        }
    },
    required: ["foo"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        bar: {
            type: "number"
        },
        foo: {
            type: "string"
        }
    },
    required: ["bar", "foo"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
