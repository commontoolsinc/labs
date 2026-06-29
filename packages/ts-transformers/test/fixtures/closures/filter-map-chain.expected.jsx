function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Item {
    id: number;
    price: number;
    active: boolean;
}
interface State {
    items: Item[];
    taxRate: number;
}
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    return item.key("active");
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
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_1 = __cfHelpers.__cf_data(__cfHelpers.exprLift("expr:+", {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, ([__cfExpr0, __cfExpr1]) => __cfExpr0 + __cfExpr1));
const __cfLift_2 = __cfHelpers.__cf_data(__cfHelpers.exprLift("expr:*", {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, ([__cfExpr0, __cfExpr1]) => __cfExpr0 * __cfExpr1));
const __cfPattern_2 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    const state = __cf_pattern_input.key("params", "state");
    return (<div>
              Total: {__cfLift_2([item.key("price"), (__cfLift_1([1, state.key("taxRate")]))])}
            </div>);
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
                        taxRate: {
                            type: "number"
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
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: filter-map-chain
// Verifies: filter+map chain with captured outer variables
//   .filter(fn) → .filterWithPattern(pattern(...), {})  — no captures
//   .map(fn)    → .mapWithPattern(pattern(...), { state: { taxRate } })
// Context: The map callback captures state.taxRate from outer scope, so it
//   appears in the params object and the map body uses a lift-applied
//   computation for the reactive computation. The filter has no captures (only element properties).
export default pattern((state) => {
    return {
        [UI]: (<div>
        {state.key("items").filterWithPattern(__cfPattern_1, {}).mapWithPattern(__cfPattern_2, {
                state: {
                    taxRate: state.key("taxRate")
                }
            })}
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
__cfReg({
    __cfPattern_1,
    __cfLift_1,
    __cfLift_2,
    __cfPattern_2
});
