function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { Cell, Default, handler, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
interface Item {
    text: Default<string, "">;
}
interface InputSchema {
    items: Default<Item[], [
    ]>;
}
const removeItem = handler({
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            asCell: true
        },
        index: {
            type: "number"
        }
    },
    required: ["items", "index"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                text: {
                    type: "string",
                    "default": ""
                }
            },
            required: ["text"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, (_, _2) => {
    // Not relevant for repro
});
// FIXTURE: map-capture-cell-param-no-name
// Verifies: pattern without generic type param still captures destructured bindings correctly
//   .map(fn) → .mapWithPattern(pattern(...), { items: items })
//   items capture → params.items (no asOpaque when schema is inferred from annotation)
// Context: Same as map-capture-cell-param but uses inline type annotation instead of generic
export default pattern((__ct_pattern_input: InputSchema) => {
    const items = __ct_pattern_input.key("items");
    return {
        [UI]: (<ul>
          {items.mapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
                const _ = __ct_pattern_input.key("element");
                const index = __ct_pattern_input.key("index");
                const items = __ct_pattern_input.key("params", "items");
                return (<li key={index}>
              <cf-button onClick={removeItem({ items, index })}>
                Remove
              </cf-button>
            </li>);
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Item"
                    },
                    index: {
                        type: "number"
                    },
                    params: {
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
                required: ["element", "params"],
                $defs: {
                    Item: {
                        type: "object",
                        properties: {
                            text: {
                                type: "string",
                                "default": ""
                            }
                        },
                        required: ["text"]
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
                items: items
            })}
        </ul>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            "default": []
        }
    },
    required: ["items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                text: {
                    type: "string",
                    "default": ""
                }
            },
            required: ["text"]
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
