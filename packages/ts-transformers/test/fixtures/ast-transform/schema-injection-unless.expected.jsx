import * as __ctHelpers from "commontools";
import { unless, pattern, UI, NAME } from "commontools";
interface State {
    value: string | null;
    defaultValue: string;
}
// FIXTURE: schema-injection-unless
// Verifies: unless() gets condition, fallback, and result schemas injected
//   unless(value, defaultValue) → unless(conditionSchema, fallbackSchema, resultSchema, value, defaultValue)
//   pattern<State>(fn)          → pattern(fn, inputSchema, outputSchema)
// Context: unless(cond, fallback) returns cond if truthy, else fallback; schemas reflect the union type
export default pattern((__ct_pattern_input) => {
    const value = __ct_pattern_input.key("value");
    const defaultValue = __ct_pattern_input.key("defaultValue");
    // unless(condition, fallback) - returns condition if truthy, else fallback
    const result = unless({
        anyOf: [{
                type: "string"
            }, {
                type: "null"
            }]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema, {
        anyOf: [{
                type: "string"
            }, {
                type: "null"
            }]
    } as const satisfies __ctHelpers.JSONSchema, value, defaultValue);
    return {
        [NAME]: "unless schema test",
        [UI]: <div>{result}</div>,
    };
}, {
    type: "object",
    properties: {
        value: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "null"
                }]
        },
        defaultValue: {
            type: "string"
        }
    },
    required: ["value", "defaultValue"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string"
        },
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$NAME", "$UI"],
    $defs: {
        JSXElement: {
            anyOf: [{
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable"
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
