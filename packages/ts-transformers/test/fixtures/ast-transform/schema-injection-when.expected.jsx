import * as __ctHelpers from "commontools";
import { when, pattern, UI, NAME } from "commontools";
interface State {
    enabled: boolean;
    message: string;
}
// FIXTURE: schema-injection-when
// Verifies: when() gets condition, value, and result schemas injected
//   when(enabled, message) → when(conditionSchema, valueSchema, resultSchema, enabled, message)
//   pattern<State>(fn)     → pattern(fn, inputSchema, outputSchema)
// Context: when(cond, value) returns value if cond is truthy, else cond; result schema is union type
export default pattern((__ct_pattern_input) => {
    const enabled = __ct_pattern_input.key("enabled");
    const message = __ct_pattern_input.key("message");
    // when(condition, value) - returns value if condition is truthy, else condition
    const result = when({
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema, {
        type: ["boolean", "string"]
    } as const satisfies __ctHelpers.JSONSchema, enabled, message);
    return {
        [NAME]: "when schema test",
        [UI]: <div>{result}</div>,
    };
}, {
    type: "object",
    properties: {
        enabled: {
            type: "boolean"
        },
        message: {
            type: "string"
        }
    },
    required: ["enabled", "message"]
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
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
