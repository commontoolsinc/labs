import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
interface State {
    items: Array<{
        value: number;
    }>;
    multiplier: number;
}
// FIXTURE: handler-nested-map
// Verifies: .map() inside a handler body is NOT transformed to .mapWithPattern()
//   onClick={() => { state.items.map(...) }) → handler(..., (_, { state }) => { state.items.map(...) })
// Context: .map() on a plain array inside a handler remains a normal JS .map(), not a reactive transform
export default pattern((state) => {
    return {
        [UI]: (<button type="button" onClick={__ctHelpers.handler(false as const satisfies __ctHelpers.JSONSchema, {
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        items: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    value: {
                                        type: "number"
                                    }
                                },
                                required: ["value"]
                            },
                            asOpaque: true
                        },
                        multiplier: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["items", "multiplier"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, (__ct_handler_event, { state }) => {
            const scaled = state.items.map((item) => item.value * state.multiplier);
            console.log(scaled);
        })({
            state: {
                items: state.key("items"),
                multiplier: state.key("multiplier")
            }
        })}>
        Compute
      </button>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    value: {
                        type: "number"
                    }
                },
                required: ["value"]
            }
        },
        multiplier: {
            type: "number"
        }
    },
    required: ["items", "multiplier"]
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
