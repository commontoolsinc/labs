import * as __ctHelpers from "commontools";
import { cell, pattern, UI } from "commontools";
interface State {
    items: Array<{
        value: number;
    }>;
    threshold: number;
}
// FIXTURE: map-capture-mixed-reactivity
// Verifies: captures of different reactivity kinds are annotated distinctly in the schema
//   label (plain string) → params.label (type: "string", accessed via .params)
//   limit (cell) → params.limit (asCell: true)
//   derived (state.threshold) → params.derived (asOpaque: true)
// Context: Three capture kinds — plain value, cell, and state-derived — in one map callback
export default pattern((state) => {
    const label = "Result";
    const limit = cell(100, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const derived = state.key("threshold");
    return {
        [UI]: (<div>
        {state.key("items").mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const item = __ct_pattern_input.key("element");
                const label = __ct_pattern_input.params.label;
                const derived = __ct_pattern_input.key("params", "derived");
                const limit = __ct_pattern_input.key("params", "limit");
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
                                asCell: true
                            }
                        },
                        required: ["label", "derived", "limit"]
                    }
                },
                required: ["element", "params"]
            } as const satisfies __ctHelpers.JSONSchema, {
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
            } as const satisfies __ctHelpers.JSONSchema), {
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
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
