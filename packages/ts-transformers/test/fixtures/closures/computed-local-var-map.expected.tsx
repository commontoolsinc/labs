import * as __ctHelpers from "commontools";
/**
 * Regression: .map() on a computed result assigned to a local variable
 * inside another computed() should NOT be transformed to .mapWithPattern().
 *
 * Inside a derive callback, OpaqueRef values are unwrapped to plain JS,
 * so `localVar` is a plain array and .mapWithPattern() doesn't exist on it.
 */
import { computed, recipe, UI } from "commontools";
interface Item {
    name: string;
    price: number;
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
} as const satisfies __ctHelpers.JSONSchema, ({ items }) => {
    const filtered = __ctHelpers.derive({
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
    } as const satisfies __ctHelpers.JSONSchema, { items: items }, ({ items }) => items.filter((i) => i.price > 100));
    return {
        [UI]: (<div>
        {__ctHelpers.derive({
                type: "object",
                properties: {
                    filtered: {
                        type: "array",
                        items: {
                            $ref: "#/$defs/Item",
                            asOpaque: true
                        },
                        asOpaque: true
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
            } as const satisfies __ctHelpers.JSONSchema, { filtered: filtered }, ({ filtered }) => {
                const localVar = filtered;
                return localVar.map((item) => <li>{item.name}</li>);
            })}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
