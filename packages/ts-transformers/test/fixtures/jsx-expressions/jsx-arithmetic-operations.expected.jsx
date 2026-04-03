import * as __cfHelpers from "commonfabric";
import { pattern, UI } from "commonfabric";
interface State {
    count: number;
    price: number;
    discount: number;
    quantity: number;
}
// FIXTURE: jsx-arithmetic-operations
// Verifies: arithmetic expressions with reactive refs in JSX are wrapped in derive()
//   {state.count + 1}                      → derive({count}, ({state}) => state.count + 1)
//   {state.price * state.quantity * 1.08}   → derive({price, quantity}, ...)
//   {state.count * state.count * state.count} → derive({count}, ...)
export default pattern((state) => {
    return {
        [UI]: (<div>
        <h3>Basic Arithmetic</h3>
        <p>Count + 1: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        count: {
                            type: "number"
                        }
                    },
                    required: ["count"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                count: state.key("count")
            } }, ({ state }) => state.count + 1)}</p>
        <p>Count - 1: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        count: {
                            type: "number"
                        }
                    },
                    required: ["count"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                count: state.key("count")
            } }, ({ state }) => state.count - 1)}</p>
        <p>Count * 2: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        count: {
                            type: "number"
                        }
                    },
                    required: ["count"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                count: state.key("count")
            } }, ({ state }) => state.count * 2)}</p>
        <p>Price / 2: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        price: {
                            type: "number"
                        }
                    },
                    required: ["price"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                price: state.key("price")
            } }, ({ state }) => state.price / 2)}</p>
        <p>Count % 3: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        count: {
                            type: "number"
                        }
                    },
                    required: ["count"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                count: state.key("count")
            } }, ({ state }) => state.count % 3)}</p>

        <h3>Complex Expressions</h3>
        <p>Discounted Price: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        price: {
                            type: "number"
                        },
                        discount: {
                            type: "number"
                        }
                    },
                    required: ["price", "discount"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                price: state.key("price"),
                discount: state.key("discount")
            } }, ({ state }) => state.price - (state.price * state.discount))}</p>
        <p>Total: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        price: {
                            type: "number"
                        },
                        quantity: {
                            type: "number"
                        }
                    },
                    required: ["price", "quantity"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                price: state.key("price"),
                quantity: state.key("quantity")
            } }, ({ state }) => state.price * state.quantity)}</p>
        <p>With Tax (8%): {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        price: {
                            type: "number"
                        },
                        quantity: {
                            type: "number"
                        }
                    },
                    required: ["price", "quantity"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                price: state.key("price"),
                quantity: state.key("quantity")
            } }, ({ state }) => (state.price * state.quantity) * 1.08)}</p>
        <p>
          Complex: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        count: {
                            type: "number"
                        },
                        quantity: {
                            type: "number"
                        },
                        price: {
                            type: "number"
                        },
                        discount: {
                            type: "number"
                        }
                    },
                    required: ["count", "quantity", "price", "discount"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                count: state.key("count"),
                quantity: state.key("quantity"),
                price: state.key("price"),
                discount: state.key("discount")
            } }, ({ state }) => (state.count + state.quantity) * state.price -
            (state.price * state.discount))}
        </p>

        <h3>Multiple Same Ref</h3>
        <p>Count³: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        count: {
                            type: "number"
                        }
                    },
                    required: ["count"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                count: state.key("count")
            } }, ({ state }) => state.count * state.count * state.count)}</p>
        <p>Price Range: ${__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        price: {
                            type: "number"
                        }
                    },
                    required: ["price"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                price: state.key("price")
            } }, ({ state }) => state.price - 10)} - ${__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        price: {
                            type: "number"
                        }
                    },
                    required: ["price"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                price: state.key("price")
            } }, ({ state }) => state.price + 10)}</p>
      </div>),
    };
}, {
    type: "object",
    properties: {
        count: {
            type: "number"
        },
        price: {
            type: "number"
        },
        discount: {
            type: "number"
        },
        quantity: {
            type: "number"
        }
    },
    required: ["count", "price", "discount", "quantity"]
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
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
