import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
interface Item {
    id: number;
    name: string;
}
interface State {
    items: Item[];
    prefix: string;
    suffix: string;
}
export default pattern((state) => {
    return {
        [UI]: (<div>
        {/* Template literal with captures */}
        {state.items.mapWithPattern(__ctHelpers.pattern(({ element: item, params: { state } }) => (<div>{__ctHelpers.derive({
                type: "object",
                properties: {
                    state: {
                        type: "object",
                        properties: {
                            prefix: {
                                type: "string",
                                asOpaque: true
                            },
                            suffix: {
                                type: "string",
                                asOpaque: true
                            }
                        },
                        required: ["prefix", "suffix"]
                    },
                    item: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string",
                                asOpaque: true
                            }
                        },
                        required: ["name"]
                    }
                },
                required: ["state", "item"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __ctHelpers.JSONSchema, {
                state: {
                    prefix: state.prefix,
                    suffix: state.suffix
                },
                item: {
                    name: item.name
                }
            }, ({ state, item }) => `${state.prefix} ${item.name} ${state.suffix}`)}</div>), {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Item"
                    },
                    params: {
                        type: "object",
                        properties: {
                            state: {
                                type: "object",
                                properties: {
                                    prefix: {
                                        type: "string",
                                        asOpaque: true
                                    },
                                    suffix: {
                                        type: "string",
                                        asOpaque: true
                                    }
                                },
                                required: ["prefix", "suffix"]
                            }
                        },
                        required: ["state"]
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
                state: {
                    prefix: state.prefix,
                    suffix: state.suffix
                }
            })}
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
        prefix: {
            type: "string"
        },
        suffix: {
            type: "string"
        }
    },
    required: ["items", "prefix", "suffix"],
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
