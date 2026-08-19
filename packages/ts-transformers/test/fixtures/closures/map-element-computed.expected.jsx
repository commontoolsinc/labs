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
import { pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Item {
    id: number;
    name: string;
}
interface State {
    items: Item[];
    prefix: string;
}
const __cfLift_1 = __cfHelpers.lift<{
    item: {
        name: string;
    };
}, string>(({ item }) => item.name.toUpperCase(), {
    type: "object",
    properties: {
        item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    },
    required: ["item"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 26, col: 28 }
});
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    const index = __cf_pattern_input.key("index");
    return (<div>
            Item #{index}: {__cfLift_1({ item: {
            name: item.key("name")
        } })}
          </div>);
}, {
    type: "object",
    properties: {
        element: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        },
        index: {
            type: "number"
        }
    },
    required: ["element"]
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
    position: { line: 24, col: 25 }
});
// FIXTURE: map-element-computed
// Verifies: .map() on reactive array is transformed with computed element property access
//   .map(fn) → .mapWithPattern(pattern(...), {})
//   item.name.toUpperCase() → lift-applied computation wrapping the computed expression
// Context: Uses index param; computation on element property triggers a lift-applied wrapper
export default __cfBindVerifiedBinding(pattern((state) => {
    return {
        [UI]: (<div>
        {/* Performs computation on element property - should wrap in computed() */}
        {state.key("items").mapWithPattern(__cfPattern_1, {})}
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
        prefix: {
            type: "string"
        }
    },
    required: ["items", "prefix"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                name: {
                    type: "string"
                }
            },
            required: ["id", "name"]
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
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 19, col: 30 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfPattern_1
});
