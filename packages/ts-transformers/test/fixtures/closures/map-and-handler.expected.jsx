function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    items: Array<{
        price: number;
    }>;
    discount: number;
    selectedIndex: Cell<number>;
}
// FIXTURE: map-and-handler
// Verifies: .map() in JSX is transformed to .mapWithPattern() and inline handler inside map body is extracted
//   state.items.map((item, index) => JSX) → state.key("items").mapWithPattern(pattern(...), { state: { discount, selectedIndex } })
//   onClick={() => state.selectedIndex.set(index)) → handler(false, { state: { selectedIndex: asCell }, index }, ...)
// Context: Combines reactive array mapping with handler extraction; map callback becomes a sub-pattern
export default pattern((state) => {
    return {
        [UI]: (<div>
        {state.key("items").mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
                const item = __cf_pattern_input.key("element");
                const index = __cf_pattern_input.key("index");
                const state = __cf_pattern_input.key("params", "state");
                return (<div>
            <span>{__cfHelpers.derive({
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
                    type: "number"
                } as const satisfies __cfHelpers.JSONSchema, {
                    item: {
                        price: item.key("price")
                    },
                    state: {
                        discount: state.key("discount")
                    }
                }, ({ item, state }) => item.price * state.discount)}</span>
            <button type="button" onClick={__cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
                    type: "object",
                    properties: {
                        index: {
                            type: "number"
                        },
                        state: {
                            type: "object",
                            properties: {
                                selectedIndex: {
                                    type: "number",
                                    asCell: ["cell"]
                                }
                            },
                            required: ["selectedIndex"]
                        }
                    },
                    required: ["index", "state"]
                } as const satisfies __cfHelpers.JSONSchema, (__cf_handler_event, { state, index }) => state.selectedIndex.set(index))({
                    state: {
                        selectedIndex: state.key("selectedIndex")
                    },
                    index: index
                })}>
              Select
            </button>
          </div>);
            }, {
                type: "object",
                properties: {
                    element: {
                        type: "object",
                        properties: {
                            price: {
                                type: "number"
                            }
                        },
                        required: ["price"]
                    },
                    index: {
                        type: "number"
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
                                    selectedIndex: {
                                        type: "number",
                                        asCell: ["cell"]
                                    }
                                },
                                required: ["discount", "selectedIndex"]
                            }
                        },
                        required: ["state"]
                    }
                },
                required: ["element", "params"]
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
                    selectedIndex: state.key("selectedIndex")
                }
            })}
        <div>
          Selected: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        items: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    price: {
                                        type: "number"
                                    }
                                },
                                required: ["price"]
                            }
                        },
                        selectedIndex: {
                            type: "number",
                            asCell: ["cell"]
                        }
                    },
                    required: ["items", "selectedIndex"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                items: state.key("items"),
                selectedIndex: state.key("selectedIndex")
            } }, ({ state }) => state.items[state.selectedIndex.get()]?.price ?? 0)} x {state.key("discount")} ={" "}
          {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        items: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    price: {
                                        type: "number"
                                    }
                                },
                                required: ["price"]
                            }
                        },
                        selectedIndex: {
                            type: "number",
                            asCell: ["cell"]
                        },
                        discount: {
                            type: "number"
                        }
                    },
                    required: ["items", "selectedIndex", "discount"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                items: state.key("items"),
                selectedIndex: state.key("selectedIndex"),
                discount: state.key("discount")
            } }, ({ state }) => (state.items[state.selectedIndex.get()]?.price ?? 0) * state.discount)}
        </div>
      </div>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    price: {
                        type: "number"
                    }
                },
                required: ["price"]
            }
        },
        discount: {
            type: "number"
        },
        selectedIndex: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["items", "discount", "selectedIndex"]
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
__cfHardenFn(h);
