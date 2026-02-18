import * as __ctHelpers from "commontools";
import { derive, pattern, UI } from "commontools";
interface SubItem {
    id: number;
    name: string;
    active: boolean;
}
interface Item {
    id: number;
    title: string;
    subItems: SubItem[];
}
interface State {
    items: Item[];
}
export default pattern((state) => {
    return {
        [UI]: (<div>
        {/* Edge case: explicit derive inside mapWithPattern with method chain.
                The inner .filter().map() should NOT be transformed because:
                - subs is a derive callback parameter (unwrapped at runtime)
                - .filter() returns a plain JS array
                - Plain arrays don't have .mapWithPattern() */}
        {state.items.mapWithPattern(__ctHelpers.pattern(({ element: item, params: {} }) => (<div>
            <h2>{item.title}</h2>
            <p>
              Active items:{" "}
              {derive({
                    type: "array",
                    items: {
                        $ref: "#/$defs/SubItem"
                    },
                    $defs: {
                        SubItem: {
                            type: "object",
                            properties: {
                                id: {
                                    type: "number"
                                },
                                name: {
                                    type: "string"
                                },
                                active: {
                                    type: "boolean"
                                }
                            },
                            required: ["id", "name", "active"]
                        }
                    }
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __ctHelpers.JSONSchema, item.subItems, (subs) => subs
                    .filter((s) => s.active)
                    .map((s) => s.name)
                    .join(", "))}
            </p>
          </div>), {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Item"
                    },
                    params: {
                        type: "object",
                        properties: {}
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
                            title: {
                                type: "string"
                            },
                            subItems: {
                                type: "array",
                                items: {
                                    $ref: "#/$defs/SubItem"
                                }
                            }
                        },
                        required: ["id", "title", "subItems"]
                    },
                    SubItem: {
                        type: "object",
                        properties: {
                            id: {
                                type: "number"
                            },
                            name: {
                                type: "string"
                            },
                            active: {
                                type: "boolean"
                            }
                        },
                        required: ["id", "name", "active"]
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
            } as const satisfies __ctHelpers.JSONSchema), {})}
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
                id: {
                    type: "number"
                },
                title: {
                    type: "string"
                },
                subItems: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/SubItem"
                    }
                }
            },
            required: ["id", "title", "subItems"]
        },
        SubItem: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                name: {
                    type: "string"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["id", "name", "active"]
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
