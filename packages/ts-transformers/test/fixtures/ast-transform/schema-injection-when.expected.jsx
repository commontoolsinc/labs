import * as __ctHelpers from "commontools";
import { when, pattern, UI, NAME } from "commontools";
interface State {
    enabled: boolean;
    message: string;
}
export default pattern(({ enabled, message }) => {
    // when(condition, value) - returns value if condition is truthy, else condition
    const result = when({
        type: "boolean",
        asOpaque: true
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "string",
        asOpaque: true
    } as const satisfies __ctHelpers.JSONSchema, {
        type: ["boolean", "string"],
        asOpaque: true
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
