import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
interface Item {
    id: string;
    tags?: string[];
}
// FIXTURE: filter-flatmap-fallback-chain
// Verifies: fallback receiver chains keep structural array-method lowering
//   (items ?? []).filter(fn).flatMap(fn).map(fn)
//     → derive(...).filterWithPattern(...).flatMapWithPattern(...).mapWithPattern(...)
// Context: Top-level JSX fallback receiver with chained collection methods and a nested callback fallback
export default pattern((__ct_pattern_input) => {
    const items = __ct_pattern_input.key("items");
    return {
        [UI]: (<div>
        {(items ?? []).filterWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
            const item = __ct_pattern_input.key("element");
            return item.key("id");
        }, {
            type: "object",
            properties: {
                element: {
                    $ref: "#/$defs/Item"
                }
            },
            required: ["element"],
            $defs: {
                Item: {
                    type: "object",
                    properties: {
                        id: {
                            type: "string"
                        },
                        tags: {
                            type: "array",
                            items: {
                                type: "string"
                            }
                        }
                    },
                    required: ["id"]
                }
            }
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema), {}).flatMapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
            const item = __ct_pattern_input.key("element");
            return __ctHelpers.derive({
                type: "object",
                properties: {
                    item: {
                        type: "object",
                        properties: {
                            tags: {
                                type: "array",
                                items: {
                                    type: "string"
                                }
                            }
                        }
                    }
                },
                required: ["item"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "array",
                items: {
                    type: "string"
                }
            } as const satisfies __ctHelpers.JSONSchema, { item: {
                    tags: item.key("tags")
                } }, ({ item }) => item.tags ?? []);
        }, {
            type: "object",
            properties: {
                element: {
                    $ref: "#/$defs/Item"
                }
            },
            required: ["element"],
            $defs: {
                Item: {
                    type: "object",
                    properties: {
                        id: {
                            type: "string"
                        },
                        tags: {
                            type: "array",
                            items: {
                                type: "string"
                            }
                        }
                    },
                    required: ["id"]
                }
            }
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "array",
            items: {
                type: "string"
            }
        } as const satisfies __ctHelpers.JSONSchema), {}).mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
            const tag = __ct_pattern_input.key("element");
            return <span>{tag}</span>;
        }, {
            type: "object",
            properties: {
                element: {
                    type: "string"
                }
            },
            required: ["element"]
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
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                tags: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["id"]
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
