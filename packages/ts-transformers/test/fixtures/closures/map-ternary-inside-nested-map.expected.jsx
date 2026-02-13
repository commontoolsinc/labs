import * as __ctHelpers from "commontools";
/**
 * Test case for ternary transformation inside nested Cell.map callbacks.
 *
 * The key scenario: A ternary inside a nested .map() callback should be
 * transformed to ifElse, because the callback body of a Cell.map is
 * back in "pattern mode" where ternaries need transformation.
 *
 * This structure mirrors pattern-nested-jsx-map: outer ternary wraps items.map,
 * causing ifElse → derive, then inner ternary is inside nested .map callback.
 */
import { Cell, computed, Default, pattern, UI } from "commontools";
interface Tag {
    name: string;
    active: boolean;
}
interface Item {
    label: string;
    tags: Tag[];
}
interface PatternInput {
    items?: Cell<Default<Item[], [
    ]>>;
    showInactive?: Default<boolean, false>;
}
export default pattern({
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            "default": [],
            asCell: true
        },
        showInactive: {
            type: "boolean",
            "default": false
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
                }
            },
            required: ["label", "tags"]
        },
        Tag: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["name", "active"]
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
} as const satisfies __ctHelpers.JSONSchema, ({ items, showInactive }) => {
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
                    }
                },
                required: ["label", "tags"]
            },
            Tag: {
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    },
                    active: {
                        type: "boolean"
                    }
                },
                required: ["name", "active"]
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
                    properties: {
                        showInactive: {
                            type: "boolean",
                            asOpaque: true
                        }
                    },
                    required: ["showInactive"]
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
                        }
                    },
                    required: ["label", "tags"]
                },
                Tag: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        },
                        active: {
                            type: "boolean"
                        }
                    },
                    required: ["name", "active"]
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
        } as const satisfies __ctHelpers.JSONSchema, ({ element: item, params: { showInactive } }) => (<div>
              {/* Ternary in outer map, outside inner map - should also be ifElse */}
              <strong>{__ctHelpers.ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string",
            asOpaque: true
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
            type: "object",
            properties: {
                item: {
                    type: "object",
                    properties: {
                        tags: {
                            type: "object",
                            properties: {
                                length: {
                                    type: "number"
                                }
                            },
                            required: ["length"]
                        }
                    },
                    required: ["tags"]
                }
            },
            required: ["item"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { item: {
                tags: {
                    length: item.tags.length
                }
            } }, ({ item }) => __ctHelpers.derive({
            type: "object",
            properties: {
                item: {
                    type: "object",
                    properties: {
                        tags: {
                            type: "object",
                            properties: {
                                length: {
                                    type: "number"
                                }
                            },
                            required: ["length"]
                        }
                    },
                    required: ["tags"]
                }
            },
            required: ["item"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { item: {
                tags: {
                    length: item.tags.length
                }
            } }, ({ item }) => item.tags.length > 0)), item.label, "No tags")}</strong>
              <ul>
                {item.tags.mapWithPattern(__ctHelpers.pattern({
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Tag"
                    },
                    params: {
                        type: "object",
                        properties: {
                            showInactive: {
                                type: "boolean",
                                asOpaque: true
                            }
                        },
                        required: ["showInactive"]
                    }
                },
                required: ["element", "params"],
                $defs: {
                    Tag: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            },
                            active: {
                                type: "boolean"
                            }
                        },
                        required: ["name", "active"]
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
            } as const satisfies __ctHelpers.JSONSchema, ({ element: tag, params: { showInactive } }) => (<li>
                    {/* This ternary should be transformed to ifElse */}
                    {__ctHelpers.ifElse({
                type: "boolean",
                asOpaque: true
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "string",
                asOpaque: true
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __ctHelpers.JSONSchema, tag.active, tag.name, __ctHelpers.derive({
                type: "object",
                properties: {
                    showInactive: {
                        type: "boolean",
                        asOpaque: true
                    },
                    tag: {
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
                required: ["showInactive", "tag"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __ctHelpers.JSONSchema, {
                showInactive: showInactive,
                tag: {
                    name: tag.name
                }
            }, ({ showInactive, tag }) => __ctHelpers.ifElse({
                type: "boolean"
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __ctHelpers.JSONSchema, showInactive, __ctHelpers.derive({
                type: "object",
                properties: {
                    tag: {
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
                required: ["tag"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __ctHelpers.JSONSchema, { tag: {
                    name: tag.name
                } }, ({ tag }) => `(${tag.name})`), "")))}
                  </li>)), {
                showInactive: showInactive
            })}
              </ul>
            </div>)), {
            showInactive: showInactive
        }), <p>No items</p>)}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
