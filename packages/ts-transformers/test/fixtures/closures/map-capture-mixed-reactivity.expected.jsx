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
import { cell, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    items: Array<{
        value: number;
    }>;
    threshold: number;
}
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    const label = __cf_pattern_input.params.label;
    const derived = __cf_pattern_input.key("params", "derived");
    const limit = __cf_pattern_input.key("params", "limit");
    return (<span>{label}: {item.key("value")} / {derived} / {limit}</span>);
}, {
    type: "object",
    properties: {
        element: {
            type: "object",
            properties: {
                value: {
                    type: "number"
                }
            },
            required: ["value"]
        },
        params: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                },
                derived: {
                    type: "number"
                },
                limit: {
                    type: "number",
                    asCell: ["readonly"]
                }
            },
            required: ["label", "derived", "limit"]
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
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfPattern_1, {
    sourceFile: "/test.tsx",
    position: { line: 24, col: 25 }
});
// FIXTURE: map-capture-mixed-reactivity
// Verifies: captures of different reactivity kinds are annotated distinctly in the schema
//   label (plain string) → params.label (type: "string", accessed via .params)
//   limit (cell, READ-only in this callback) → params.limit (asCell: ["readonly"])
//     — read-only usage yields the precise `readonly` capability, not the broader
//       `cell`. (The capture is created with cell(100) but never written here.)
//   derived (state.threshold) → params.derived (asOpaque: true)
// Context: Three capture kinds — plain value, cell, and state-derived — in one map callback
export default __cfBindVerifiedBinding(pattern((state) => {
    const label = "Result";
    const limit = cell(100, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("limit", true);
    const derived = state.key("threshold");
    return {
        [UI]: (<div>
        {state.key("items").mapWithPattern(__cfPattern_1, {
                label: label,
                derived: derived,
                limit: limit
            })}
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
                    value: {
                        type: "number"
                    }
                },
                required: ["value"]
            }
        },
        threshold: {
            type: "number"
        }
    },
    required: ["items", "threshold"]
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
    position: { line: 17, col: 30 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfPattern_1
});
