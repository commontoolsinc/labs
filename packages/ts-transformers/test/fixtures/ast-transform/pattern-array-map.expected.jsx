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
import { Cell, computed, handler, NAME, pattern, str, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const adder = handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        values: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: ["writeonly"]
        }
    },
    required: ["values"]
} as const satisfies __cfHelpers.JSONSchema, (_, state: {
    values: Cell<string[]>;
}) => {
    state.values.push(Math.random().toString(36).substring(2, 15));
});
__cfBindVerifiedBinding(adder, {
    sourceFile: "/test.tsx",
    position: { line: 4, col: 22 },
    bindingName: "adder"
});
const __cfLift_1 = __cfHelpers.lift<{
    values: unknown[];
}, void>(({ values }) => {
    console.log("values#", values?.length);
}, {
    type: "object",
    properties: {
        values: {
            type: "array",
            items: {
                type: "unknown"
            }
        }
    },
    required: ["values"]
} as const satisfies __cfHelpers.JSONSchema, {
    asCell: ["opaque"]
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 17, col: 13 }
});
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const value = __cf_pattern_input.key("element");
    const index = __cf_pattern_input.key("index");
    return (<div>
                {index}: {value}
              </div>);
}, {
    type: "object",
    properties: {
        element: {
            type: "string"
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
    position: { line: 26, col: 24 }
});
// FIXTURE: pattern-array-map
// Verifies: .map() on a reactive array is transformed to .mapWithPattern()
//   values.map((value, index) => JSX)  → values.mapWithPattern(pattern(fn, elementSchema, outputSchema), {})
//   computed(() => { ... })            → captures `values` into lift(inputSchema, outputSchema, fn)
//   handler((_, state: {...}) => ...)  → handler(false, stateSchema, fn)
//   pattern<{ values: string[] }>      → pattern(fn, inputSchema, outputSchema)
// Context: Destructured pattern parameter; combines array map transform with computed and handler schemas
export default __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const values = __cf_pattern_input.key("values");
    __cfLift_1({ values: values });
    return {
        [NAME]: str `Simple Value: ${values.key("length")}`,
        [UI]: (<div>
          <button type="button" onClick={adder({ values })}>Add Value</button>
          <div>
            {values.mapWithPattern(__cfPattern_1, {})}
          </div>
        </div>),
        values,
    };
}, {
    type: "object",
    properties: {
        values: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["values"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string"
        },
        $UI: {
            $ref: "#/$defs/JSXElement"
        },
        values: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["$NAME", "$UI", "values"],
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
    position: { line: 16, col: 2 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    adder,
    __cfLift_1,
    __cfPattern_1
});
