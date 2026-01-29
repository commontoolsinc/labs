import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
interface Item {
    id: number;
    price: number;
    active: boolean;
}
interface State {
    items: Item[];
    taxRate: number;
}
export default recipe({
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        },
        taxRate: {
            type: "number"
        }
    },
    required: ["items", "taxRate"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                price: {
                    type: "number"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["id", "price", "active"]
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
        {/* Method chain: filter then map, both with captures */}
        {__lift_0({ state: {
                items: state.items
            } }).mapWithPattern(__ctHelpers.recipe({
            type: "object",
            properties: {
                element: {
                    $ref: "#/$defs/Item",
                    asOpaque: true
                },
                params: {
                    type: "object",
                    properties: {
                        state: {
                            type: "object",
                            properties: {
                                taxRate: {
                                    type: "number",
                                    asOpaque: true
                                }
                            },
                            required: ["taxRate"]
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
                        price: {
                            type: "number"
                        },
                        active: {
                            type: "boolean"
                        }
                    },
                    required: ["id", "price", "active"]
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
        } as const satisfies __ctHelpers.JSONSchema, ({ element: item, params: { state } }) => (<div>
              Total: {__ctHelpers.derive({
            type: "object",
            properties: {
                item: {
                    type: "object",
                    properties: {
                        price: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["price"]
                },
                state: {
                    type: "object",
                    properties: {
                        taxRate: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["taxRate"]
                }
            },
            required: ["item", "state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, {
            item: {
                price: item.price
            },
            state: {
                taxRate: state.taxRate
            }
        }, ({ item, state }) => item.price * (1 + state.taxRate))}
            </div>)), {
            state: {
                taxRate: state.taxRate
            }
        })}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
const __lift_0 = __ctHelpers.lift({
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
                id: {
                    type: "number"
                },
                price: {
                    type: "number"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["id", "price", "active"]
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
                id: {
                    type: "number"
                },
                price: {
                    type: "number"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["id", "price", "active"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, ({ state }) => state.items
    .filter((item) => item.active));
