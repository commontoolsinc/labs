function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { computed, fetchData, ifElse, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
// Tests ifElse where ifTrue is explicitly undefined
// This pattern is common: ifElse(pending, undefined, { result })
// The transformer must handle this correctly - the undefined is a VALUE, not a missing argument
// FIXTURE: ifelse-undefined-value
// Verifies: ifElse with explicit undefined as ifTrue or ifFalse branch is handled correctly
//   ifElse(cond, undefined, {result}) → ifElse(schema, schema, schema, schema, derive(...), undefined, {result})
//   ifElse(cond, {data}, undefined)   → ifElse(schema, schema, schema, schema, derive(...), {data}, undefined)
// Context: undefined is a VALUE argument, not a missing argument
export default pattern(() => {
    const { pending, result } = fetchData({
        url: "/api/data",
        mode: "text",
    });
    // Pattern 1: undefined as ifTrue (waiting state returns nothing)
    const output1 = ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "undefined"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "object",
        properties: {
            result: {
                type: "unknown"
            }
        },
        required: ["result"]
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{
                type: "undefined"
            }, {
                type: "object",
                properties: {
                    result: {
                        type: "unknown"
                    }
                },
                required: ["result"]
            }]
    } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
        type: "object",
        properties: {
            pending: {
                type: "boolean"
            },
            result: {
                type: "unknown"
            }
        },
        required: ["pending", "result"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        pending: pending,
        result: result
    }, ({ pending, result }) => pending || !result), undefined, { result });
    // Pattern 2: undefined as ifFalse (error state returns nothing)
    const output2 = ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "object",
        properties: {
            data: {
                type: "unknown"
            }
        },
        required: ["data"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "undefined"
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{
                type: "undefined"
            }, {
                type: "object",
                properties: {
                    data: {
                        type: "unknown"
                    }
                },
                required: ["data"]
            }]
    } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
        type: "object",
        properties: {
            result: {
                type: "unknown"
            }
        },
        required: ["result"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, { result: result }, ({ result }) => !!result), { data: result }, undefined);
    return {
        [UI]: (<div>
        <span>{output1}</span>
        <span>{output2}</span>
      </div>),
    };
}, {
    type: "object",
    properties: {},
    additionalProperties: false
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$UI"],
    $defs: {
        JSXElement: {
            anyOf: [{
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    $ref: "#/$defs/UIRenderable"
                }, {
                    type: "object",
                    properties: {}
                }]
        },
        UIRenderable: {
            type: "object",
            properties: {
                $UI: {
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }
            },
            required: ["$UI"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__ctHardenFn(h);
