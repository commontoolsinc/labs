function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { computed, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
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
// FIXTURE: jsx-complex-mixed
// Verifies: mixed transforms -- map, filter, arithmetic, ternary/ifElse, attribute bindings in one pattern
//   .filter(fn)              → .filterWithPattern(pattern(...), {captures})
//   .map(fn)                 → .mapWithPattern(pattern(...), {captures})
//   ternary cond ? a : b     → ifElse(derive(cond), a, b)
//   {state.discount * 100}   → derive({discount}, ...)
// Context: Comprehensive fixture combining array methods, conditionals, derive, and attributes
export default pattern((state) => {
    return {
        [UI]: (<div>
        <h3>Array Operations</h3>
        <p>Total items: {state.key("items", "length")}</p>
        <p>
          Filtered count:{" "}
          {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                items: state.key("items"),
                filter: state.key("filter")
            } }, ({ state }) => state.items.filter((i) => i.name.includes(state.filter)).length)}
        </p>

        <h3>Array with Complex Expressions</h3>
        <ul>
          {state.key("items").mapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
                const item = __ct_pattern_input.key("element");
                const state = __ct_pattern_input.key("params", "state");
                return (<li key={item.key("id")}>
              <span>{item.key("name")}</span>
              <span>- Original: ${item.key("price")}</span>
              <span>
                - Discounted: ${__cfHelpers.derive({
                    type: "object",
                    properties: {
                        item: {
                            type: "object",
                            properties: {
                                price: {
                                    type: "number"
                                }
                            },
                            required: ["price"]
                        },
                        state: {
                            type: "object",
                            properties: {
                                discount: {
                                    type: "number"
                                }
                            },
                            required: ["discount"]
                        }
                    },
                    required: ["item", "state"]
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __cfHelpers.JSONSchema, {
                    item: {
                        price: item.key("price")
                    },
                    state: {
                        discount: state.key("discount")
                    }
                }, ({ item, state }) => (item.price * (1 - state.discount)).toFixed(2))}
              </span>
              <span>
                - With tax:
                ${__cfHelpers.derive({
                    type: "object",
                    properties: {
                        item: {
                            type: "object",
                            properties: {
                                price: {
                                    type: "number"
                                }
                            },
                            required: ["price"]
                        },
                        state: {
                            type: "object",
                            properties: {
                                discount: {
                                    type: "number"
                                },
                                taxRate: {
                                    type: "number"
                                }
                            },
                            required: ["discount", "taxRate"]
                        }
                    },
                    required: ["item", "state"]
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __cfHelpers.JSONSchema, {
                    item: {
                        price: item.key("price")
                    },
                    state: {
                        discount: state.key("discount"),
                        taxRate: state.key("taxRate")
                    }
                }, ({ item, state }) => (item.price * (1 - state.discount) * (1 + state.taxRate))
                    .toFixed(2))}
              </span>
            </li>);
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
                                    discount: {
                                        type: "number"
                                    },
                                    taxRate: {
                                        type: "number"
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
            } as const satisfies __cfHelpers.JSONSchema, {
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
            } as const satisfies __cfHelpers.JSONSchema), {
                state: {
                    discount: state.key("discount"),
                    taxRate: state.key("taxRate")
                }
            })}
        </ul>

        <h3>Array Methods</h3>
        <p>Item count: {state.key("items", "length")}</p>
        <p>Active items: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        items: {
                            type: "array",
                            items: {
                                $ref: "#/$defs/Item"
                            }
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                items: state.key("items")
            } }, ({ state }) => state.items.filter((i) => i.active).length)}</p>

        <h3>Simple Operations</h3>
        <p>Discount percent: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        discount: {
                            type: "number"
                        }
                    },
                    required: ["discount"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                discount: state.key("discount")
            } }, ({ state }) => state.discount * 100)}%</p>
        <p>Tax percent: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        taxRate: {
                            type: "number"
                        }
                    },
                    required: ["taxRate"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                taxRate: state.key("taxRate")
            } }, ({ state }) => state.taxRate * 100)}%</p>

        <h3>Array Predicates</h3>
        <p>All active: {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Yes", "No"]
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        items: {
                            type: "array",
                            items: {
                                $ref: "#/$defs/Item"
                            }
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                items: state.key("items")
            } }, ({ state }) => state.items.every((i) => i.active)), "Yes", "No")}</p>
        <p>Any active: {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Yes", "No"]
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        items: {
                            type: "array",
                            items: {
                                $ref: "#/$defs/Item"
                            }
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                items: state.key("items")
            } }, ({ state }) => state.items.some((i) => i.active)), "Yes", "No")}</p>
        <p>
          Has expensive (gt 100):{" "}
          {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Yes", "No"]
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        items: {
                            type: "array",
                            items: {
                                $ref: "#/$defs/Item"
                            }
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                items: state.key("items")
            } }, ({ state }) => state.items.some((i) => i.price > 100)), "Yes", "No")}
        </p>

        <h3>Object Operations</h3>
        <div data-item-count={state.key("items", "length")} data-has-filter={__cfHelpers.derive({
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                filter: {
                    length: state.key("filter", "length")
                }
            } }, ({ state }) => state.filter.length > 0)} data-discount={state.key("discount")}>
          Object attributes
        </div>
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
} as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__ctHardenFn(h);
