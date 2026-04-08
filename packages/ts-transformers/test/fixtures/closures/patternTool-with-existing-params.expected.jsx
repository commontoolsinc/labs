function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { cell, derive, pattern, patternTool, type PatternToolResult } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const multiplier = cell(2, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const offset = cell(10, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
type Output = {
    tool: PatternToolResult<{
        offset: number;
    }>;
};
// Test: patternTool with an existing extraParam, and a new capture
// The function has { value: number, offset: number } as input type
// We provide offset via extraParams, and the transformer should capture multiplier
// FIXTURE: patternTool-with-existing-params
// Verifies: patternTool merges auto-captured vars into pre-existing extraParams
//   patternTool(fn, { offset }) → patternTool(fn, { multiplier, offset })
//   callback signature gains captured param: ({ value, offset }) → ({ value, offset, multiplier })
// Context: `offset` is already provided as an explicit extraParam. The transformer
//   detects that `multiplier` (module-scoped cell) is also captured and merges it
//   into the existing extraParams without duplicating `offset`.
export default pattern(() => {
    const tool = patternTool(({ value, offset, multiplier }: {
        value: number;
        offset: number;
        multiplier: import("commonfabric").Cell<number>;
    }) => {
        return derive({
            type: "object",
            properties: {
                value: {
                    type: "number"
                },
                offset: {
                    type: "number"
                }
            },
            required: ["value", "offset"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { value, offset }, ({ value, offset }) => {
            return value * multiplier.get() + offset;
        });
    }, {
        multiplier: multiplier,
        offset
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
                    properties: {
                        offset: {
                            type: "number"
                        }
                    },
                    required: ["offset"]
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
__cfHardenFn(h);
