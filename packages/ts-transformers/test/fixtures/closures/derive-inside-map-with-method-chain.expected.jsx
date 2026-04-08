function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { derive, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
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
// FIXTURE: derive-inside-map-with-method-chain
// Verifies: derive nested inside .map() correctly transforms outer .map() but leaves inner chains alone
//   state.items.map(fn) → state.items.mapWithPattern(pattern(...))
//   inner .filter().map() inside derive callback → NOT transformed (plain array)
// Context: derive is used inline in JSX within a mapWithPattern callback
export default pattern((state) => {
    return {
        [UI]: (<div>
        {/* Edge case: explicit derive inside mapWithPattern with method chain.
                The inner .filter().map() should NOT be transformed because:
                - subs is a derive callback parameter (unwrapped at runtime)
                - .filter() returns a plain JS array
                - Plain arrays don't have .mapWithPattern() */}
        {state.key("items").mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
                const item = __cf_pattern_input.key("element");
                return (<div>
            <h2>{item.key("title")}</h2>
            <p>
              Active items:{" "}
              {derive({
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
                    } as const satisfies __cfHelpers.JSONSchema, {
                        type: "string"
                    } as const satisfies __cfHelpers.JSONSchema, item.key("subItems"), (subs) => subs
                        .filter((s) => s.active)
                        .map((s) => s.name)
                        .join(", "))}
            </p>
          </div>);
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
            } as const satisfies __cfHelpers.JSONSchema), {})}
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
