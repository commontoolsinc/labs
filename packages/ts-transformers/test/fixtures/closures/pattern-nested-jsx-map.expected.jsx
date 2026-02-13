import * as __ctHelpers from "commontools";
/**
 * Test case for nested map transformation inside ternary.
 *
 * The key scenario: `item.tags.map(...)` where `item` is from an outer
 * `mapWithPattern` callback, and the whole thing is inside a ternary
 * that gets wrapped in `ifElse` → `derive`.
 *
 * The inner map on `item.tags` should still be transformed to
 * `mapWithPattern` because `item` comes from a mapWithPattern element,
 * NOT from the derive's captures.
 */
import { Cell, computed, Default, pattern, UI } from "commontools";
interface Tag {
    name: string;
}
interface Item {
    label: string;
    tags: Tag[];
    selectedIndex: number;
}
interface PatternInput {
    items?: Cell<Default<Item[], [
    ]>>;
}
export default pattern(({ items }) => {
    const hasItems = __ctHelpers.derive({
        type: "object",
        properties: {
            items: {
                type: "array",
                items: {
                    $ref: "#/$defs/Item"
                },
                asCell: true
            }
        },
        required: ["items"],
        $defs: {
            Item: {
                type: "object",
                properties: {
                    label: {
                        type: "string"
                    },
                    tags: {
                        type: "array",
                        items: {
                            $ref: "#/$defs/Tag"
                        }
                    },
                    selectedIndex: {
                        type: "number"
                    }
                },
                required: ["label", "tags", "selectedIndex"]
            },
            Tag: {
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    }
                },
                required: ["name"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema, { items: items }, ({ items }) => items.get().length > 0);
    return {
        [UI]: (<div>
        {__ctHelpers.ifElse({
            type: "boolean",
            asOpaque: true
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "array",
            items: {
                $ref: "#/$defs/UIRenderable"
            },
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
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    type: "object",
                    properties: {}
                }, {
                    type: "array",
                    items: {
                        $ref: "#/$defs/UIRenderable"
                    },
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
        } as const satisfies __ctHelpers.JSONSchema, hasItems, items.mapWithPattern(__ctHelpers.pattern({
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
                        label: {
                            type: "string"
                        },
                        tags: {
                            type: "array",
                            items: {
                                $ref: "#/$defs/Tag"
                            }
                        },
                        selectedIndex: {
                            type: "number"
                        }
                    },
                    required: ["label", "tags", "selectedIndex"]
                },
                Tag: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        }
                    },
                    required: ["name"]
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
        } as const satisfies __ctHelpers.JSONSchema, ({ element: item, params: {} }) => (<div>
              <strong>{item.label}</strong>
              <ul>
                {item.tags.mapWithPattern(__ctHelpers.pattern({
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Tag"
                    },
                    index: {
                        type: "number"
                    },
                    params: {
                        type: "object",
                        properties: {
                            item: {
                                type: "object",
                                properties: {
                                    selectedIndex: {
                                        type: "number",
                                        asOpaque: true
                                    }
                                },
                                required: ["selectedIndex"]
                            }
                        },
                        required: ["item"]
                    }
                },
                required: ["element", "params"],
                $defs: {
                    Tag: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            }
                        },
                        required: ["name"]
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
            } as const satisfies __ctHelpers.JSONSchema, ({ element: tag, index: i, params: { item } }) => (<li>
                    {__ctHelpers.ifElse({
                type: "boolean"
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __ctHelpers.JSONSchema, {
                "enum": ["", "* "]
            } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
                type: "object",
                properties: {
                    i: {
                        type: "number",
                        asOpaque: true
                    },
                    item: {
                        type: "object",
                        properties: {
                            selectedIndex: {
                                type: "number",
                                asOpaque: true
                            }
                        },
                        required: ["selectedIndex"]
                    }
                },
                required: ["i", "item"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "boolean"
            } as const satisfies __ctHelpers.JSONSchema, {
                i: i,
                item: {
                    selectedIndex: item.selectedIndex
                }
            }, ({ i, item }) => __ctHelpers.derive({
                type: "object",
                properties: {
                    i: {
                        type: "number",
                        asOpaque: true
                    },
                    item: {
                        type: "object",
                        properties: {
                            selectedIndex: {
                                type: "number",
                                asOpaque: true
                            }
                        },
                        required: ["selectedIndex"]
                    }
                },
                required: ["i", "item"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "boolean"
            } as const satisfies __ctHelpers.JSONSchema, {
                i: i,
                item: {
                    selectedIndex: item.selectedIndex
                }
            }, ({ i, item }) => i === item.selectedIndex)), "* ", "")}
                    {tag.name}
                  </li>)), {
                item: {
                    selectedIndex: item.selectedIndex
                }
            })}
              </ul>
            </div>)), {}), <p>No items</p>)}
      </div>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            "default": [],
            asCell: true
        }
    },
    $defs: {
        Item: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                },
                tags: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Tag"
                    }
                },
                selectedIndex: {
                    type: "number"
                }
            },
            required: ["label", "tags", "selectedIndex"]
        },
        Tag: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
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
