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
    name: string;
    active: boolean;
}
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    return ({
        name: item.key("name"),
        active: item.key("active"),
    });
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
                name: {
                    type: "string"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["name", "active"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        name: {
            type: "string"
        },
        active: {
            type: "boolean"
        }
    },
    required: ["name", "active"]
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfPattern_1, {
    sourceFile: "/test.tsx",
    position: { line: 20, col: 15 }
});
const __cfPattern_2 = __cfHelpers.pattern(__cf_pattern_input => {
    const entry = __cf_pattern_input.key("element");
    return entry.key("active");
}, {
    type: "object",
    properties: {
        element: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["name", "active"]
        }
    },
    required: ["element"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfPattern_2, {
    sourceFile: "/test.tsx",
    position: { line: 24, col: 18 }
});
const __cfPattern_3 = __cfHelpers.pattern(__cf_pattern_input => {
    const entry = __cf_pattern_input.key("element");
    return <span>{entry.key("name")}</span>;
}, {
    type: "object",
    properties: {
        element: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["name", "active"]
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
__cfBindVerifiedBinding(__cfPattern_3, {
    sourceFile: "/test.tsx",
    position: { line: 25, col: 15 }
});
// FIXTURE: map-jsx-map-filter-chain
// Verifies: chained .map().filter().map() on reactive array all transform
//   .map(fn)    → .mapWithPattern(pattern(...), {})
//   .filter(fn) → .filterWithPattern(pattern(...), {})
//   .map(fn)    → .mapWithPattern(pattern(...), {})
// Context: Three-step chain; no outer captures in any callback
export default __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const list = __cf_pattern_input.key("list");
    return {
        [UI]: (<div>
        {list.mapWithPattern(__cfPattern_1, {}).filterWithPattern(__cfPattern_2, {}).mapWithPattern(__cfPattern_3, {})}
      </div>),
    };
}, {
    type: "object",
    properties: {
        list: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        }
    },
    required: ["list"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["name", "active"]
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
    position: { line: 15, col: 41 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfPattern_1,
    __cfPattern_2,
    __cfPattern_3
});
