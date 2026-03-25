import * as __cfHelpers from "commonfabric";
import { pattern, UI } from "commonfabric";
interface State {
    items: number[];
    settings: {
        multiplier: number;
    };
}
// FIXTURE: map-capture-derived-from-param
// Verifies: variable derived from state (const settings = state.settings) is captured correctly
//   .map(fn) → .mapWithPattern(pattern(...), { settings: { multiplier: settings.key("multiplier") } })
//   item * settings.multiplier → derive() keeps item as an explicit input and closes over the callback-owned settings param
export default pattern((state) => {
    const settings = state.key("settings");
    return {
        [UI]: (<div>
        {state.key("items").mapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
                const item = __ct_pattern_input.key("element");
                const settings = __ct_pattern_input.key("params", "settings");
                return (<span>{__cfHelpers.derive({
                    type: "object",
                    properties: {
                        item: {
                            type: "number"
                        }
                    },
                    required: ["item"]
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "number"
                } as const satisfies __cfHelpers.JSONSchema, { item: item }, ({ item }) => item * settings.multiplier)}</span>);
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
            } as const satisfies __cfHelpers.JSONSchema), {
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
