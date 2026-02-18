import * as __ctHelpers from "commontools";
import { computed, fetchData, ifElse, pattern, UI } from "commontools";
// Tests ifElse where ifTrue is explicitly undefined
// This pattern is common: ifElse(pending, undefined, { result })
// The transformer must handle this correctly - the undefined is a VALUE, not a missing argument
export default pattern(() => {
    const { pending, result } = fetchData({
        url: "/api/data",
        mode: "text",
    });
    // Pattern 1: undefined as ifTrue (waiting state returns nothing)
    const output1 = ifElse({
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema, true as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            result: {
                asOpaque: true
            }
        },
        required: ["result"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            result: {
                asOpaque: true
            }
        },
        required: ["result"],
        asOpaque: true
    } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
        type: "object",
        properties: {
            pending: {
                type: "boolean",
                asOpaque: true
            },
            result: {
                asOpaque: true
            }
        },
        required: ["pending", "result"]
    } as const satisfies __ctHelpers.JSONSchema, {
        anyOf: [{
                type: "boolean",
                "enum": [false]
            }, {
                type: "boolean",
                asOpaque: true
            }]
    } as const satisfies __ctHelpers.JSONSchema, {
        pending: pending,
        result: result
    }, ({ pending, result }) => pending || !result), undefined, { result });
    // Pattern 2: undefined as ifFalse (error state returns nothing)
    const output2 = ifElse({
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            data: {
                asOpaque: true
            }
        },
        required: ["data"]
    } as const satisfies __ctHelpers.JSONSchema, true as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            data: {
                asOpaque: true
            }
        },
        required: ["data"],
        asOpaque: true
    } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
        type: "object",
        properties: {
            result: {
                asOpaque: true
            }
        },
        required: ["result"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema, { result: result }, ({ result }) => !!result), { data: result }, undefined);
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
} as const satisfies __ctHelpers.JSONSchema, {
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
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable",
                    asOpaque: true
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
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
