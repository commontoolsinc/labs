import * as __ctHelpers from "commontools";
import { Default, handler, NAME, pattern, UI, wish, Writable, } from "commontools";
type Item = {
    name: string;
    value: number;
};
const removeItem = handler({
    type: "object",
    properties: {},
    additionalProperties: false
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
        item: {
            $ref: "#/$defs/Item"
        }
    },
    required: ["items", "item"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                value: {
                    type: "number"
                }
            },
            required: ["name", "value"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, (_, { items, item }) => {
    items.remove(item);
});
// FIXTURE: map-wish-default-handler-capture
// Verifies: wish<Default<Array<T>, []>>().result maps still lower to mapWithPattern with handler captures
//   wish<Default<Item[], []>>(...).result!.map(fn) -> mapWithPattern(pattern(...), { items: items })
//   removeItem({ items, item })                    -> captures both the reactive array and the current element
// Context: The array comes from wish().result rather than a pattern param or a local cell
export default pattern((_) => {
    const items = wish<Default<Item[], [
    ]>>({ query: "#items" }, {
        type: "array",
        items: {
            $ref: "#/$defs/Item"
        },
        "default": [],
        $defs: {
            Item: {
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    },
                    value: {
                        type: "number"
                    }
                },
                required: ["name", "value"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema).result!;
    return {
        [NAME]: "Test",
        [UI]: (<ul>
        {items.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const item = __ct_pattern_input.key("element");
                const items = __ct_pattern_input.params.items;
                return (<li>
            {item.key("name")}
            <button type="button" onClick={removeItem({ items, item })}>
              Remove
            </button>
          </li>);
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Item"
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
                            name: {
                                type: "string"
                            },
                            value: {
                                type: "number"
                            }
                        },
                        required: ["name", "value"]
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
    properties: {},
    additionalProperties: false
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
