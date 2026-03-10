import * as __ctHelpers from "commontools";
import { pattern, Writable, UI } from "commontools";
interface State {
    items: Array<{
        name: string;
    }>;
}
// FIXTURE: map-capture-writable-of
// Verifies: Writable.of() variable closed over in .map() is captured with asCell annotation
//   .map(fn) → .mapWithPattern(pattern(...), { selected: selected })
//   Writable.of<string | null>(null) → params.selected with { anyOf: [string, null], asCell: true }
export default pattern((state) => {
    const selected = Writable.of<string | null>(null, {
        anyOf: [{
                type: "string"
            }, {
                type: "null"
            }]
    } as const satisfies __ctHelpers.JSONSchema);
    return {
        [UI]: (<div>
        {state.key("items").mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const item = __ct_pattern_input.key("element");
                const selected = __ct_pattern_input.key("params", "selected");
                return (<span>{item.key("name")} {selected}</span>);
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
                    params: {
                        type: "object",
                        properties: {
                            selected: {
                                anyOf: [{
                                        type: "string"
                                    }, {
                                        type: "null"
                                    }],
                                asCell: true
                            }
                        },
                        required: ["selected"]
                    }
                },
                required: ["element", "params"]
            } as const satisfies __ctHelpers.JSONSchema, {
                anyOf: [{
                        $ref: "https://commonfabric.org/schemas/vnode.json"
                    }, {
                        type: "object",
                        properties: {}
                    }, {
                        $ref: "#/$defs/UIRenderable"
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
                selected: selected
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
                    name: {
                        type: "string"
                    }
                },
                required: ["name"]
            }
        }
    },
    required: ["items"]
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
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable"
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
