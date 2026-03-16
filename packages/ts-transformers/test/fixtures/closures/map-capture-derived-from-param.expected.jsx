import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
interface State {
    items: number[];
    settings: {
        multiplier: number;
    };
}
// FIXTURE: map-capture-derived-from-param
// Verifies: variable derived from state (const settings = state.settings) is captured correctly
//   .map(fn) → .mapWithPattern(pattern(...), { settings: { multiplier: settings.key("multiplier") } })
//   item * settings.multiplier → derive() with both element and captured param inputs
export default pattern((state) => {
    const settings = state.key("settings");
    return {
        [UI]: (<div>
        {state.key("items").mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const item = __ct_pattern_input.key("element");
                const settings = __ct_pattern_input.key("params", "settings");
                return (<span>{__ctHelpers.derive({
                    type: "object",
                    properties: {
                        item: {
                            type: "number"
                        },
                        settings: {
                            type: "object",
                            properties: {
                                multiplier: {
                                    type: "number"
                                }
                            },
                            required: ["multiplier"]
                        }
                    },
                    required: ["item", "settings"]
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "number"
                } as const satisfies __ctHelpers.JSONSchema, {
                    item: item,
                    settings: {
                        multiplier: settings.key("multiplier")
                    }
                }, ({ item, settings }) => item * settings.multiplier)}</span>);
            }, {
                type: "object",
                properties: {
                    element: {
                        type: "number"
                    },
                    params: {
                        type: "object",
                        properties: {
                            settings: {
                                type: "object",
                                properties: {
                                    multiplier: {
                                        type: "number"
                                    }
                                },
                                required: ["multiplier"]
                            }
                        },
                        required: ["settings"]
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
                settings: {
                    multiplier: settings.key("multiplier")
                }
            })}
      </div>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "number"
            }
        },
        settings: {
            type: "object",
            properties: {
                multiplier: {
                    type: "number"
                }
            },
            required: ["multiplier"]
        }
    },
    required: ["items", "settings"]
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
