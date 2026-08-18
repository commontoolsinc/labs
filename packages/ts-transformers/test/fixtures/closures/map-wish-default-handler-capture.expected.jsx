function __cfBindVerifiedBinding(value: any, metadata: any) {
    if (value && (typeof value === "object" || typeof value === "function") && Object.isExtensible(value)) {
        Object.defineProperty(value, "__cfVerifiedBindingIdentity", {
            value: metadata,
            configurable: true
        });
    }
    if (value && (typeof value === "object" || typeof value === "function") && typeof value.implementation === "function") {
        var implementation = value.implementation;
        if (implementation && (typeof implementation === "object" || typeof implementation === "function") && Object.isExtensible(implementation)) {
            Object.defineProperty(implementation, "__cfVerifiedBindingIdentity", {
                value: metadata,
                configurable: true
            });
        }
    }
    return value;
}
function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Default, handler, NAME, pattern, UI, wish, Writable, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
type Item = {
    name: string;
    value: number;
};
const removeItem = handler({
    type: "object",
    properties: {},
    additionalProperties: false
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            "default": [],
            asCell: ["writeonly"]
        },
        item: {
            $ref: "#/$defs/Item"
        }
    },
    required: ["items", "item"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                value: {
                    type: "number"
                }
            },
            required: ["name", "value"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, (_, { items, item }) => {
    items.remove(item);
});
__cfBindVerifiedBinding(removeItem, {
    sourceFile: "/test.tsx",
    position: { line: 17, col: 2 },
    bindingName: "removeItem"
});
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    const items = __cf_pattern_input.key("params", "items");
    return (<li>
            {item.key("name")}
            <button type="button" onClick={removeItem({ items, item })}>
              Remove
            </button>
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
                items: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Item"
                    },
                    "default": []
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
                name: {
                    type: "string"
                },
                value: {
                    type: "number"
                }
            },
            required: ["name", "value"]
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
__cfBindVerifiedBinding(__cfPattern_1, {
    sourceFile: "/test.tsx",
    position: { line: 33, col: 19 }
});
// FIXTURE: map-wish-default-handler-capture
// Verifies: wish<Default<Array<T>, []>>().result maps still lower to mapWithPattern with handler captures
//   wish<Default<Item[], []>>(...).result!.map(fn) -> mapWithPattern(pattern(...), { items: items })
//   removeItem({ items, item })                    -> captures both the reactive array and the current element
// Context: The array comes from wish().result rather than a pattern param or a local cell
export default __cfBindVerifiedBinding(pattern((_) => {
    const __cf_destructure_1 = wish<Default<Item[], [
    ]>>({ query: "#items" }, {
        type: "array",
        items: {
            $ref: "#/$defs/Item"
        },
        "default": [],
        $defs: {
            Item: {
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    },
                    value: {
                        type: "number"
                    }
                },
                required: ["name", "value"]
            }
        }
    } as const satisfies __cfHelpers.JSONSchema), items = __cf_destructure_1.key("result").for("items", true);
    return {
        [NAME]: "Test",
        [UI]: (<ul>
        {items.mapWithPattern(__cfPattern_1, {
                items: items
            })}
      </ul>),
    };
}, {
    type: "object",
    properties: {},
    additionalProperties: false
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string"
        },
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$NAME", "$UI"],
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
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 26, col: 46 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    removeItem,
    __cfPattern_1
});
