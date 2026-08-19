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
    id: string;
    tags?: string[];
}
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    return item.key("id");
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
                    type: "string"
                },
                tags: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["id"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfPattern_1, {
    sourceFile: "/test.tsx",
    position: { line: 19, col: 18 }
});
const __cfPattern_2 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    return item.key("tags") ?? [];
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
                    type: "string"
                },
                tags: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["id"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfPattern_2, {
    sourceFile: "/test.tsx",
    position: { line: 20, col: 19 }
});
const __cfPattern_3 = __cfHelpers.pattern(__cf_pattern_input => {
    const tag = __cf_pattern_input.key("element");
    return <span>{tag}</span>;
}, {
    type: "object",
    properties: {
        element: {
            type: "string"
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
    position: { line: 21, col: 15 }
});
// FIXTURE: filter-flatmap-fallback-chain
// Verifies: fallback receiver chains keep structural array-method lowering
//   (items ?? []).filter(fn).flatMap(fn).map(fn)
//     → lift(...)(...).filterWithPattern(...).flatMapWithPattern(...).mapWithPattern(...)
// Context: Top-level JSX fallback receiver with chained collection methods and a nested callback fallback
export default __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    return {
        [UI]: (<div>
        {(items ?? []).filterWithPattern(__cfPattern_1, {}).flatMapWithPattern(__cfPattern_2, {}).mapWithPattern(__cfPattern_3, {})}
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
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                tags: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["id"]
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
    position: { line: 14, col: 43 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfPattern_1,
    __cfPattern_2,
    __cfPattern_3
});
