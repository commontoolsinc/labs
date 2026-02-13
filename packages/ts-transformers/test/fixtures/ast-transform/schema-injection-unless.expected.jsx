import * as __ctHelpers from "commontools";
import { unless, pattern, UI, NAME } from "commontools";
interface State {
    value: string | null;
    defaultValue: string;
}
export default pattern({
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
} as const satisfies __ctHelpers.JSONSchema, ({ value, defaultValue }) => {
    // unless(condition, fallback) - returns condition if truthy, else fallback
    const result = unless({
        anyOf: [{
                type: "string"
            }, {
                type: "null"
            }],
        asOpaque: true
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "string",
        asOpaque: true
    } as const satisfies __ctHelpers.JSONSchema, {
        anyOf: [{
                type: "string"
            }, {
                type: "null"
            }],
        asOpaque: true
    } as const satisfies __ctHelpers.JSONSchema, value, defaultValue);
    return {
        [NAME]: "unless schema test",
        [UI]: <div>{result}</div>,
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
