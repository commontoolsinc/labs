import * as __ctHelpers from "commontools";
import { Cell, handler, ifElse, pattern, UI } from "commontools";
interface Item {
    id: number;
    name: string;
}
// Handler that closes over both items array and individual item
const removeItem = handler(true as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item",
                asCell: true
            },
            asCell: true
        },
        item: {
            $ref: "#/$defs/Item",
            asCell: true
        }
    },
    required: ["items", "item"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                name: {
                    type: "string"
                }
            },
            required: ["id", "name"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, (_event, { items, item }) => {
    const currentItems = items.get();
    const index = currentItems.findIndex((el) => el.equals(item));
    if (index >= 0) {
        items.set(currentItems.toSpliced(index, 1));
    }
});
export default pattern(({ items, hasItems }) => {
    // CT-1035: Map inside ifElse branches should transform to mapWithPattern
    // The handler closure should work correctly with the map iterator variable
    return {
        [UI]: (<div>
          {ifElse({
                type: "boolean",
                asOpaque: true
            } as const satisfies __ctHelpers.JSONSchema, {
                anyOf: [{}, {
                        type: "object",
                        properties: {}
                    }]
            } as const satisfies __ctHelpers.JSONSchema, {
                anyOf: [{}, {
                        type: "object",
                        properties: {}
                    }]
            } as const satisfies __ctHelpers.JSONSchema, {
                $ref: "#/$defs/UIRenderable",
                asOpaque: true,
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
            } as const satisfies __ctHelpers.JSONSchema, hasItems, <div>
              {items.mapWithPattern(__ctHelpers.pattern(({ element: item, params: { items } }) => (<div>
                  <span>{item.name}</span>
                  <button type="button" onClick={removeItem({ items, item })}>Remove</button>
                </div>), {
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
                                    },
                                    asOpaque: true
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
                                id: {
                                    type: "number"
                                },
                                name: {
                                    type: "string"
                                }
                            },
                            required: ["id", "name"]
                        }
                    }
                } as const satisfies __ctHelpers.JSONSchema, {
                    anyOf: [{
                            $ref: "https://commonfabric.org/schemas/vnode.json"
                        }, {
                            type: "object",
                            properties: {}
                        }, {
                            $ref: "#/$defs/UIRenderable",
                            asOpaque: true
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
            </div>, <div>No items</div>)}
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
        },
        hasItems: {
            type: "boolean"
        }
    },
    required: ["items", "hasItems"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                name: {
                    type: "string"
                }
            },
            required: ["id", "name"]
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
