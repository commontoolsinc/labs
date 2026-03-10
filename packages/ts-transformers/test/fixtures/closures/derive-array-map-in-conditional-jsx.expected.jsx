import * as __ctHelpers from "commontools";
/**
 * Bug repro: computed() array result used with .map() inside a conditional branch.
 *
 * sorted is OpaqueRef<Item[]> (from computed()). In the ternary's truthy branch,
 * sorted.map() should be rewritten to sorted.mapWithPattern() — but the branch
 * should NOT be wrapped in a derive, since the .map() → .mapWithPattern() rewrite
 * is handled by ClosureTransformer directly.
 */
import { computed, pattern, UI, Writable } from "commontools";
interface Item {
    name: string;
    value: number;
}
export default pattern((state) => {
    const showList = Writable.of(true, {
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema);
    // computed() returning an array — transformer converts to derive()
    const sorted = __ctHelpers.derive({
        type: "object",
        properties: {
            state: {
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
        required: ["state"],
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
        type: "array",
        items: {
            $ref: "#/$defs/Item",
            asOpaque: true
        },
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
    } as const satisfies __ctHelpers.JSONSchema, { state: {
            items: state.key("items")
        } }, ({ state }) => [...state.items].sort((a, b) => a.value - b.value));
    return {
        [UI]: (<div>
        {__ctHelpers.ifElse({
            type: "boolean",
            asCell: true
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
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __ctHelpers.JSONSchema, showList, <div>
              {sorted.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const item = __ct_pattern_input.key("element");
                return (<span>{item.key("name")}</span>);
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Item",
                        asOpaque: true
                    }
                },
                required: ["element"],
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
            </div>, <span>Hidden</span>)}
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
