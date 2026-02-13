import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
interface State {
    items: Array<{
        price: number;
    }>;
    discount: number;
}
export default pattern({
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    price: {
                        type: "number"
                    }
                },
                required: ["price"]
            }
        },
        discount: {
            type: "number"
        }
    },
    required: ["items", "discount"]
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
} as const satisfies __ctHelpers.JSONSchema, (state: State) => {
    return {
        [UI]: (<div>
        {state.items.map((item) => (<span>{__ctHelpers.derive({
                type: "object",
                properties: {
                    item: {
                        type: "object",
                        properties: {
                            price: {
                                type: "number"
                            }
                        },
                        required: ["price"]
                    },
                    state: {
                        type: "object",
                        properties: {
                            discount: {
                                type: "number"
                            }
                        },
                        required: ["discount"]
                    }
                },
                required: ["item", "state"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "number"
            } as const satisfies __ctHelpers.JSONSchema, {
                item: {
                    price: item.price
                },
                state: {
                    discount: state.discount
                }
            }, ({ item, state }) => item.price * state.discount)}</span>))}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
