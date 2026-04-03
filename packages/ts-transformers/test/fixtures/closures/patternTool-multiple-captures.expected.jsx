function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { derive, pattern, patternTool, type PatternToolResult, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
const multiplier = __cfHelpers.__ct_data(Writable.of(2, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema));
const prefix = __cfHelpers.__ct_data(Writable.of("Result: ", {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema));
type Output = {
    tool: PatternToolResult<Record<string, never>>;
};
// FIXTURE: patternTool-multiple-captures
// Verifies: patternTool with no explicit extraParams auto-captures multiple module-scoped reactive vars
//   patternTool(fn) → patternTool(fn, { prefix, multiplier })
//   callback signature gains captured params: ({ value }) → ({ value, prefix, multiplier })
// Context: Both `prefix` and `multiplier` are module-scoped Writable.of() values
//   referenced via .get() inside the callback. The transformer detects both and
//   injects them into the extraParams object and the callback's destructured input.
export default pattern(() => {
    const tool = patternTool(({ value, prefix, multiplier }: {
        value: number;
        prefix: import("commonfabric").Cell<string>;
        multiplier: import("commonfabric").Cell<number>;
    }) => {
        return derive({
            type: "object",
            properties: {
                value: {
                    type: "number"
                }
            },
            required: ["value"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { value }, ({ value }) => {
            return prefix.get() + String(value * multiplier.get());
        });
    }, {
        prefix: prefix,
        multiplier: multiplier
    });
    return { tool };
}, {
    type: "object",
    properties: {},
    additionalProperties: false
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        tool: {
            type: "object",
            properties: {
                pattern: {
                    $ref: "#/$defs/Pattern"
                },
                extraParams: {
                    type: "object",
                    properties: {},
                    additionalProperties: false
                }
            },
            required: ["pattern", "extraParams"]
        }
    },
    required: ["tool"],
    $defs: {
        Pattern: {
            type: "object",
            properties: {
                argumentSchema: true,
                resultSchema: true
            },
            required: ["argumentSchema", "resultSchema"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__ctHardenFn(h);
