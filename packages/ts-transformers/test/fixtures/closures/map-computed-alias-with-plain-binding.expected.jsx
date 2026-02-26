import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
function dynamicKey(): "value" {
    return "value";
}
interface Item {
    foo: number;
    value: number;
}
interface State {
    items: Item[];
}
export default pattern((state) => {
    return {
        [UI]: (<div>
        {state.items.map(({ foo, [dynamicKey()]: val }) => (<span>{__ctHelpers.derive({
                type: "object",
                properties: {
                    foo: {
                        type: "number",
                        asOpaque: true
                    },
                    val: {
                        type: "number",
                        asOpaque: true
                    }
                },
                required: ["foo", "val"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "number"
            } as const satisfies __ctHelpers.JSONSchema, {
                foo: foo,
                val: val
            }, ({ foo, val }) => foo + val)}</span>))}
      </div>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        }
    },
    required: ["items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                foo: {
                    type: "number"
                },
                value: {
                    type: "number"
                }
            },
            required: ["foo", "value"]
        }
    }
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
