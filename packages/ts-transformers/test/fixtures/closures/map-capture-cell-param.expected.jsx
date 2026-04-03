import * as __ctHelpers from "commontools";
import { Cell, Default, handler, pattern, UI } from "commontools";
interface Item {
    text: Default<string, "">;
}
interface InputSchema {
    items: Default<Item[], [
    ]>;
}
const removeItem = handler({
    type: "unknown"
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            asCell: true
        },
        index: {
            type: "number"
        }
    },
    required: ["items", "index"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                text: {
                    type: "string",
                    "default": ""
                }
            },
            required: ["text"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, (_, _2) => {
    // Not relevant for repro
});
// FIXTURE: map-capture-cell-param
// Verifies: destructured pattern param closed over in .map() is captured as opaque
//   .map(fn) → .mapWithPattern(pattern(...), { items: items })
//   items (from pattern destructuring) → params.items with asOpaque: true
// Context: Captures the parent array as opaque to pass to a handler alongside the map index
export default pattern((__ct_pattern_input) => {
    const items = __ct_pattern_input.key("items");
    return {
        [UI]: (<ul>
          {items.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const _ = __ct_pattern_input.key("element");
                const index = __ct_pattern_input.key("index");
                const items = __ct_pattern_input.key("params", "items");
                return (<li key={index}>
              <ct-button onClick={removeItem({ items, index })}>
                Remove
              </ct-button>
            </li>);
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Item"
                    },
                    index: {
                        type: "number"
                    },
                    params: {
                        type: "object",
                        properties: {
                            items: {
                                type: "array",
                                items: {
                                    $ref: "#/$defs/Item"
                                }
                            }
                        },
                        required: ["items"]
                    }
                },
                required: ["element", "params"],
                $defs: {
                    Item: {
                        type: "object",
                        properties: {
                            text: {
                                type: "string",
                                "default": ""
                            }
                        },
                        required: ["text"]
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, {
                anyOf: [{
                        $ref: "https://commonfabric.org/schemas/vnode.json"
                    }, {
                        $ref: "#/$defs/UIRenderable"
                    }, {
                        type: "object",
                        properties: {}
                    }],
                $defs: {
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
            } as const satisfies __ctHelpers.JSONSchema), {
                items: items
            })}
        </ul>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            "default": []
        }
    },
    required: ["items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                text: {
                    type: "string",
                    "default": ""
                }
            },
            required: ["text"]
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
