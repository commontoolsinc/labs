function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, derive, handler, NAME, pattern, str, UI } from "commonfabric";
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
            asCell: true
        }
    },
    required: ["values"]
} as const satisfies __cfHelpers.JSONSchema, (_, state: {
    values: Cell<string[]>;
}) => {
    state.values.push(Math.random().toString(36).substring(2, 15));
});
// FIXTURE: pattern-array-map
// Verifies: .map() on a reactive array is transformed to .mapWithPattern()
//   values.map((value, index) => JSX)  → values.mapWithPattern(pattern(fn, elementSchema, outputSchema), {})
//   derive(values, fn)                 → derive(inputSchema, outputSchema, values, fn)
//   handler((_, state: {...}) => ...)  → handler(false, stateSchema, fn)
//   pattern<{ values: string[] }>      → pattern(fn, inputSchema, outputSchema)
// Context: Destructured pattern parameter; combines array map transform with derive and handler schemas
export default pattern((__cf_pattern_input) => {
    const values = __cf_pattern_input.key("values");
    derive({
        type: "array",
        items: {
            type: "unknown"
        }
    } as const satisfies __cfHelpers.JSONSchema, true as const satisfies __cfHelpers.JSONSchema, values, (values) => {
        console.log("values#", values?.length);
    });
    return {
        [NAME]: str `Simple Value: ${values.key("length")}`,
        [UI]: (<div>
          <button type="button" onClick={adder({ values })}>Add Value</button>
          <div>
            {values.mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
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
            } as const satisfies __cfHelpers.JSONSchema), {})}
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
