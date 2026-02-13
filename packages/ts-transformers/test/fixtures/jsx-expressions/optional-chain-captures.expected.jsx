import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
interface Item {
    maybe?: {
        value: number;
    };
}
interface State {
    maybe?: {
        value: number;
    };
    items: Item[];
}
export default pattern({
    type: "object",
    properties: {
        maybe: {
            type: "object",
            properties: {
                value: {
                    type: "number"
                }
            },
            required: ["value"]
        },
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
                maybe: {
                    type: "object",
                    properties: {
                        value: {
                            type: "number"
                        }
                    },
                    required: ["value"]
                }
            }
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
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        <span>{state.maybe?.value}</span>
        {state.items.mapWithPattern(__ctHelpers.pattern({
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
                            maybe: {
                                type: "object",
                                properties: {
                                    value: {
                                        type: "number"
                                    }
                                },
                                required: ["value"]
                            }
                        }
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
            } as const satisfies __ctHelpers.JSONSchema, ({ element: item, params: {} }) => (<span>{__ctHelpers.derive({
                type: "object",
                properties: {
                    item: {
                        type: "object",
                        properties: {
                            maybe: {
                                type: "object",
                                properties: {
                                    value: {
                                        type: "number"
                                    }
                                },
                                required: ["value"],
                                asOpaque: true
                            }
                        }
                    }
                },
                required: ["item"]
            } as const satisfies __ctHelpers.JSONSchema, {
                anyOf: [{
                        type: "number",
                        "enum": [0]
                    }, {
                        type: "number",
                        asOpaque: true
                    }]
            } as const satisfies __ctHelpers.JSONSchema, { item: {
                    maybe: item.maybe
                } }, ({ item }) => item.maybe?.value ?? 0)}</span>)), {})}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
