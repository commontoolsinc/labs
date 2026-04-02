function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
/**
 * Regression: .map() on a computed result assigned to a local variable
 * inside another computed() should NOT be transformed to .mapWithPattern().
 *
 * Inside a derive callback, OpaqueRef values are unwrapped to plain JS,
 * so `localVar` is a plain array and .mapWithPattern() doesn't exist on it.
 */
import { computed, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
interface Item {
    name: string;
    price: number;
}
// FIXTURE: computed-local-var-map
// Verifies: .map() on a local variable assigned from a computed result inside another computed() is NOT transformed to .mapWithPattern()
//   computed(() => { const localVar = filtered; return localVar.map(fn) }) → derive(..., ({ filtered }) => { const localVar = filtered; return localVar.map(fn) })
// Context: Inside a derive callback, OpaqueRef values are unwrapped to plain JS,
//   so `localVar` is a plain array. The .map() must remain untransformed.
//   This is a negative test for reactive .map() detection on local aliases.
export default pattern((__ct_pattern_input) => {
    const items = __ct_pattern_input.key("items");
    const filtered = __cfHelpers.derive({
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
                    name: {
                        type: "string"
                    },
                    price: {
                        type: "number"
                    }
                },
                required: ["name", "price"]
            }
        }
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "array",
        items: {
            $ref: "#/$defs/Item"
        },
        $defs: {
            Item: {
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    },
                    price: {
                        type: "number"
                    }
                },
                required: ["name", "price"]
            }
        }
    } as const satisfies __cfHelpers.JSONSchema, { items: items }, ({ items }) => items.filter((i) => i.price > 100));
    return {
        [UI]: (<div>
        {__cfHelpers.derive({
                type: "object",
                properties: {
                    filtered: {
                        type: "array",
                        items: {
                            $ref: "#/$defs/Item"
                        }
                    }
                },
                required: ["filtered"],
                $defs: {
                    Item: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            },
                            price: {
                                type: "number"
                            }
                        },
                        required: ["name", "price"]
                    }
                }
            } as const satisfies __cfHelpers.JSONSchema, {
                type: "array",
                items: {
                    $ref: "#/$defs/JSXElement"
                },
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
            } as const satisfies __cfHelpers.JSONSchema, { filtered: filtered }, ({ filtered }) => {
                const localVar = filtered;
                return localVar.map((item) => <li>{item.name}</li>);
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
        }
    },
    required: ["items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                price: {
                    type: "number"
                }
            },
            required: ["name", "price"]
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
