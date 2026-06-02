function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, pattern, patternTool, type PatternToolResult, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_1 = __cfHelpers.lift<{
    value: number;
}, string>({
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, ({ value }) => {
    return prefix.get() + String(value * multiplier.get());
});
const multiplier = __cfHelpers.__cf_data(new Writable(2, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema).for("multiplier", true));
const prefix = __cfHelpers.__cf_data(new Writable("Result: ", {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema).for("prefix", true));
type Output = {
    tool: PatternToolResult<Record<string, never>>;
};
// FIXTURE: patternTool-multiple-captures
// Verifies: patternTool with no explicit extraParams auto-captures multiple module-scoped reactive vars
//   patternTool(fn) → patternTool(fn, { prefix, multiplier })
//   callback signature gains captured params: ({ value }) → ({ value, prefix, multiplier })
// Context: Both `prefix` and `multiplier` are module-scoped new Writable() values
//   referenced via .get() inside the callback. The transformer detects both and
//   injects them into the extraParams object and the callback's destructured input.
export default pattern(() => {
    const tool = patternTool(({ value, prefix, multiplier }: {
        value: number;
        prefix: __cfHelpers.Cell<string>;
        multiplier: __cfHelpers.Cell<number>;
    }) => {
        return __cfLift_1({ value: value });
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
                },
                useResultSchemaForObservation: {
                    type: "boolean"
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
                resultSchema: true,
                internalSchema: true,
                defaultScope: {
                    $ref: "#/$defs/CellScope"
                }
            },
            required: ["argumentSchema", "resultSchema"]
        },
        CellScope: {
            "enum": ["space", "user", "session"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
