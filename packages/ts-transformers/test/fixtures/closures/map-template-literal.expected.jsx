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
// FIXTURE: map-template-literal
// Verifies: .map() on reactive array is transformed when callback uses a template literal with captures
//   .map(fn) → .mapWithPattern(pattern(...), {state: {prefix, suffix}})
//   `${state.prefix} ${item.name} ${state.suffix}` → derive() wrapping the template
// Context: Template literal interpolations reference both element and captured state properties
export default pattern((state) => {
    return {
        [UI]: (<div>
        {/* Template literal with captures */}
        {state.key("items").mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const item = __ct_pattern_input.key("element");
                const state = __ct_pattern_input.key("params", "state");
                return (<div>{__ctHelpers.derive({
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
                        prefix: state.key("prefix"),
                        suffix: state.key("suffix")
                    },
                    item: {
                        name: item.key("name")
                    }
                }, ({ state, item }) => `${state.prefix} ${item.name} ${state.suffix}`)}</div>);
            }, {
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
                    prefix: state.key("prefix"),
                    suffix: state.key("suffix")
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
