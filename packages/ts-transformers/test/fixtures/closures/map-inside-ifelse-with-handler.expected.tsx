import * as __ctHelpers from "commontools";
import { Cell, handler, ifElse, recipe, UI } from "commontools";
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
export default recipe({
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
                    $ref: "#/$defs/VNode"
                }, {
                    $ref: "#/$defs/VNodeResult"
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
                    $ref: "#/$defs/VNode"
                }
            },
            required: ["$UI"]
        },
        VNodeResult: {
            type: "object",
            properties: {
                type: {
                    type: "string",
                    "enum": ["vnode"]
                },
                name: {
                    type: "string"
                },
                props: {
                    $ref: "#/$defs/PropsResult"
                },
                children: {
                    type: "array",
                    items: {
                        anyOf: [{
                                type: "string"
                            }, {
                                type: "number"
                            }, {
                                type: "boolean",
                                "enum": [false]
                            }, {
                                type: "boolean",
                                "enum": [true]
                            }, {
                                $ref: "#/$defs/VNodeResult"
                            }, {
                                type: "null"
                            }]
                    }
                },
                $UI: {
                    $ref: "#/$defs/VNodeResult"
                }
            },
            required: ["type", "name", "props"]
        },
        PropsResult: {
            type: "object",
            properties: {},
            additionalProperties: {
                anyOf: [{
                        type: "string"
                    }, {
                        type: "number"
                    }, {
                        type: "boolean",
                        "enum": [false]
                    }, {
                        type: "boolean",
                        "enum": [true]
                    }, {
                        type: "object",
                        additionalProperties: true
                    }, {
                        type: "array",
                        items: true
                    }, {
                        asStream: true
                    }, {
                        type: "null"
                    }]
            }
        },
        VNode: {
            type: "object",
            properties: {
                type: {
                    type: "string",
                    "enum": ["vnode"]
                },
                name: {
                    type: "string"
                },
                props: {
                    $ref: "#/$defs/Props"
                },
                children: {
                    $ref: "#/$defs/RenderNode"
                },
                $UI: {
                    $ref: "#/$defs/VNode"
                }
            },
            required: ["type", "name", "props"]
        },
        RenderNode: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "number"
                }, {
                    type: "boolean",
                    "enum": [false]
                }, {
                    type: "boolean",
                    "enum": [true]
                }, {
                    $ref: "#/$defs/VNode"
                }, {
                    $ref: "#/$defs/VNodeResult"
                }, {
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable",
                    asOpaque: true
                }, {
                    type: "object",
                    properties: {}
                }, {
                    type: "array",
                    items: {
                        $ref: "#/$defs/RenderNode"
                    }
                }, {
                    type: "null"
                }]
        },
        Props: {
            type: "object",
            properties: {},
            additionalProperties: {
                anyOf: [{
                        type: "string"
                    }, {
                        type: "number"
                    }, {
                        type: "boolean",
                        "enum": [false]
                    }, {
                        type: "boolean",
                        "enum": [true]
                    }, {
                        type: "object",
                        additionalProperties: true
                    }, {
                        type: "array",
                        items: true
                    }, {
                        asCell: true
                    }, {
                        asStream: true
                    }, {
                        type: "null"
                    }]
            }
        }
    }
} as const satisfies __ctHelpers.JSONSchema, ({ items, hasItems }) => {
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
                type: "object",
                properties: {
                    $UI: {
                        $ref: "#/$defs/VNodeResult"
                    }
                },
                required: ["$UI"],
                asOpaque: true,
                $defs: {
                    VNodeResult: {
                        type: "object",
                        properties: {
                            type: {
                                type: "string"
                            },
                            name: {
                                type: "string"
                            },
                            props: {
                                $ref: "#/$defs/PropsResult"
                            },
                            children: {
                                type: "array",
                                items: {
                                    anyOf: [{
                                            type: "string"
                                        }, {
                                            type: "number"
                                        }, {
                                            type: "boolean"
                                        }, {
                                            $ref: "#/$defs/VNodeResult"
                                        }, {
                                            type: "null"
                                        }]
                                }
                            },
                            $UI: {
                                $ref: "#/$defs/VNodeResult"
                            }
                        },
                        required: ["type", "name", "props"]
                    },
                    PropsResult: {
                        type: "object",
                        properties: {},
                        additionalProperties: {
                            anyOf: [{
                                    type: "string"
                                }, {
                                    type: "number"
                                }, {
                                    type: "boolean"
                                }, {
                                    type: "object",
                                    additionalProperties: true
                                }, {
                                    type: "array",
                                    items: true
                                }, {
                                    asStream: true
                                }, {
                                    type: "null"
                                }]
                        }
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, hasItems, <div>
              {items.mapWithPattern(__ctHelpers.recipe({
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
                            $ref: "#/$defs/VNode"
                        }, {
                            $ref: "#/$defs/VNodeResult"
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
                                    $ref: "#/$defs/VNode"
                                }
                            },
                            required: ["$UI"]
                        },
                        VNodeResult: {
                            type: "object",
                            properties: {
                                type: {
                                    type: "string",
                                    "enum": ["vnode"]
                                },
                                name: {
                                    type: "string"
                                },
                                props: {
                                    $ref: "#/$defs/PropsResult"
                                },
                                children: {
                                    type: "array",
                                    items: {
                                        anyOf: [{
                                                type: "string"
                                            }, {
                                                type: "number"
                                            }, {
                                                type: "boolean",
                                                "enum": [false]
                                            }, {
                                                type: "boolean",
                                                "enum": [true]
                                            }, {
                                                $ref: "#/$defs/VNodeResult"
                                            }, {
                                                type: "null"
                                            }]
                                    }
                                },
                                $UI: {
                                    $ref: "#/$defs/VNodeResult"
                                }
                            },
                            required: ["type", "name", "props"]
                        },
                        PropsResult: {
                            type: "object",
                            properties: {},
                            additionalProperties: {
                                anyOf: [{
                                        type: "string"
                                    }, {
                                        type: "number"
                                    }, {
                                        type: "boolean",
                                        "enum": [false]
                                    }, {
                                        type: "boolean",
                                        "enum": [true]
                                    }, {
                                        type: "object",
                                        additionalProperties: true
                                    }, {
                                        type: "array",
                                        items: true
                                    }, {
                                        asStream: true
                                    }, {
                                        type: "null"
                                    }]
                            }
                        },
                        VNode: {
                            type: "object",
                            properties: {
                                type: {
                                    type: "string",
                                    "enum": ["vnode"]
                                },
                                name: {
                                    type: "string"
                                },
                                props: {
                                    $ref: "#/$defs/Props"
                                },
                                children: {
                                    $ref: "#/$defs/RenderNode"
                                },
                                $UI: {
                                    $ref: "#/$defs/VNode"
                                }
                            },
                            required: ["type", "name", "props"]
                        },
                        RenderNode: {
                            anyOf: [{
                                    type: "string"
                                }, {
                                    type: "number"
                                }, {
                                    type: "boolean",
                                    "enum": [false]
                                }, {
                                    type: "boolean",
                                    "enum": [true]
                                }, {
                                    $ref: "#/$defs/VNode"
                                }, {
                                    $ref: "#/$defs/VNodeResult"
                                }, {
                                    type: "object",
                                    properties: {}
                                }, {
                                    $ref: "#/$defs/UIRenderable",
                                    asOpaque: true
                                }, {
                                    type: "object",
                                    properties: {}
                                }, {
                                    type: "array",
                                    items: {
                                        $ref: "#/$defs/RenderNode"
                                    }
                                }, {
                                    type: "null"
                                }]
                        },
                        Props: {
                            type: "object",
                            properties: {},
                            additionalProperties: {
                                anyOf: [{
                                        type: "string"
                                    }, {
                                        type: "number"
                                    }, {
                                        type: "boolean",
                                        "enum": [false]
                                    }, {
                                        type: "boolean",
                                        "enum": [true]
                                    }, {
                                        type: "object",
                                        additionalProperties: true
                                    }, {
                                        type: "array",
                                        items: true
                                    }, {
                                        asCell: true
                                    }, {
                                        asStream: true
                                    }, {
                                        type: "null"
                                    }]
                            }
                        }
                    }
                } as const satisfies __ctHelpers.JSONSchema, ({ element: item, params: { items } }) => (<div>
                  <span>{item.name}</span>
                  <button type="button" onClick={removeItem({ items, item })}>Remove</button>
                </div>)), {
                    items: items
                })}
            </div>, <div>No items</div>)}
        </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
