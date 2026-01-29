import * as __ctHelpers from "commontools";
import { derive, recipe, UI } from "commontools";
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
export default recipe({
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
                    $ref: "#/$defs/VNode"
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
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        {/* Edge case: explicit derive inside mapWithPattern with method chain.
                The inner .filter().map() should NOT be transformed because:
                - subs is a derive callback parameter (unwrapped at runtime)
                - .filter() returns a plain JS array
                - Plain arrays don't have .mapWithPattern() */}
        {state.items.mapWithPattern(__ctHelpers.recipe({
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
                        $ref: "#/$defs/VNode"
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
            } as const satisfies __ctHelpers.JSONSchema, ({ element: item, params: {} }) => (<div>
            <h2>{item.title}</h2>
            <p>
              Active items:{" "}
              {__lift_0(item.subItems)}
            </p>
          </div>)), {})}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
const __lift_0 = __ctHelpers.lift({
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
} as const satisfies __ctHelpers.JSONSchema, (subs) => subs
    .filter((s) => s.active)
    .map((s) => s.name)
    .join(", "));
