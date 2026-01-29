import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
interface Item {
    id: number;
    name: string;
    price: number;
    active: boolean;
}
interface State {
    items: Item[];
    filter: string;
    discount: number;
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
        filter: {
            type: "string"
        },
        discount: {
            type: "number"
        },
        taxRate: {
            type: "number"
        }
    },
    required: ["items", "filter", "discount", "taxRate"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                name: {
                    type: "string"
                },
                price: {
                    type: "number"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["id", "name", "price", "active"]
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
        <h3>Array Operations</h3>
        <p>Total items: {state.items.length}</p>
        <p>
          Filtered count:{" "}
          {__lift_0({ state: {
                items: state.items,
                filter: state.filter
            } })}
        </p>

        <h3>Array with Complex Expressions</h3>
        <ul>
          {state.items.mapWithPattern(__ctHelpers.recipe({
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
                                    discount: {
                                        type: "number",
                                        asOpaque: true
                                    },
                                    taxRate: {
                                        type: "number",
                                        asOpaque: true
                                    }
                                },
                                required: ["discount", "taxRate"]
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
                            },
                            price: {
                                type: "number"
                            },
                            active: {
                                type: "boolean"
                            }
                        },
                        required: ["id", "name", "price", "active"]
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
            } as const satisfies __ctHelpers.JSONSchema, ({ element: item, params: { state } }) => (<li key={item.id}>
              <span>{item.name}</span>
              <span>- Original: ${item.price}</span>
              <span>
                - Discounted: ${__ctHelpers.derive({
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
                            discount: {
                                type: "number",
                                asOpaque: true
                            }
                        },
                        required: ["discount"]
                    }
                },
                required: ["item", "state"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __ctHelpers.JSONSchema, {
                item: {
                    price: item.price
                },
                state: {
                    discount: state.discount
                }
            }, ({ item, state }) => (item.price * (1 - state.discount)).toFixed(2))}
              </span>
              <span>
                - With tax:
                ${__ctHelpers.derive({
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
                            discount: {
                                type: "number",
                                asOpaque: true
                            },
                            taxRate: {
                                type: "number",
                                asOpaque: true
                            }
                        },
                        required: ["discount", "taxRate"]
                    }
                },
                required: ["item", "state"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __ctHelpers.JSONSchema, {
                item: {
                    price: item.price
                },
                state: {
                    discount: state.discount,
                    taxRate: state.taxRate
                }
            }, ({ item, state }) => (item.price * (1 - state.discount) * (1 + state.taxRate))
                .toFixed(2))}
              </span>
            </li>)), {
                state: {
                    discount: state.discount,
                    taxRate: state.taxRate
                }
            })}
        </ul>

        <h3>Array Methods</h3>
        <p>Item count: {state.items.length}</p>
        <p>Active items: {__lift_2({ state: {
                items: state.items
            } })}</p>

        <h3>Simple Operations</h3>
        <p>Discount percent: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        discount: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["discount"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                discount: state.discount
            } }, ({ state }) => state.discount * 100)}%</p>
        <p>Tax percent: {__ctHelpers.derive({
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
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                taxRate: state.taxRate
            } }, ({ state }) => state.taxRate * 100)}%</p>

        <h3>Array Predicates</h3>
        <p>All active: {__ctHelpers.ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["Yes", "No"]
        } as const satisfies __ctHelpers.JSONSchema, __lift_4({ state: {
                items: state.items
            } }), "Yes", "No")}</p>
        <p>Any active: {__ctHelpers.ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["Yes", "No"]
        } as const satisfies __ctHelpers.JSONSchema, __lift_6({ state: {
                items: state.items
            } }), "Yes", "No")}</p>
        <p>
          Has expensive (gt 100):{" "}
          {__ctHelpers.ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["Yes", "No"]
        } as const satisfies __ctHelpers.JSONSchema, __lift_8({ state: {
                items: state.items
            } }), "Yes", "No")}
        </p>

        <h3>Object Operations</h3>
        <div data-item-count={state.items.length} data-has-filter={__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        filter: {
                            type: "object",
                            properties: {
                                length: {
                                    type: "number"
                                }
                            },
                            required: ["length"]
                        }
                    },
                    required: ["filter"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                filter: {
                    length: state.filter.length
                }
            } }, ({ state }) => state.filter.length > 0)} data-discount={state.discount}>
          Object attributes
        </div>
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
                },
                filter: {
                    type: "string",
                    asOpaque: true
                }
            },
            required: ["items", "filter"]
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
                name: {
                    type: "string"
                },
                price: {
                    type: "number"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["id", "name", "price", "active"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema, ({ state }) => state.items.filter((i) => i.name.includes(state.filter)).length);
const __lift_2 = __ctHelpers.lift({
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
                name: {
                    type: "string"
                },
                price: {
                    type: "number"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["id", "name", "price", "active"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema, ({ state }) => state.items.filter((i) => i.active).length);
const __lift_4 = __ctHelpers.lift({
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
                name: {
                    type: "string"
                },
                price: {
                    type: "number"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["id", "name", "price", "active"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __ctHelpers.JSONSchema, ({ state }) => state.items.every((i) => i.active));
const __lift_6 = __ctHelpers.lift({
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
                name: {
                    type: "string"
                },
                price: {
                    type: "number"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["id", "name", "price", "active"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __ctHelpers.JSONSchema, ({ state }) => state.items.some((i) => i.active));
const __lift_8 = __ctHelpers.lift({
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
                name: {
                    type: "string"
                },
                price: {
                    type: "number"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["id", "name", "price", "active"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __ctHelpers.JSONSchema, ({ state }) => state.items.some((i) => i.price > 100));
