import * as __cfHelpers from "commonfabric";
import { pattern, UI } from "commonfabric";
interface Item {
    name: string;
    active: boolean;
}
// FIXTURE: map-jsx-map-filter-chain
// Verifies: chained .map().filter().map() on reactive array all transform
//   .map(fn)    → .mapWithPattern(pattern(...), {})
//   .filter(fn) → .filterWithPattern(pattern(...), {})
//   .map(fn)    → .mapWithPattern(pattern(...), {})
// Context: Three-step chain; no outer captures in any callback
export default pattern((__ct_pattern_input) => {
    const list = __ct_pattern_input.key("list");
    return {
        [UI]: (<div>
        {list.mapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
                const item = __ct_pattern_input.key("element");
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
            } as const satisfies __cfHelpers.JSONSchema), {}).filterWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
                const entry = __ct_pattern_input.key("element");
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
            } as const satisfies __cfHelpers.JSONSchema), {}).mapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
                const entry = __ct_pattern_input.key("element");
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
            } as const satisfies __cfHelpers.JSONSchema), {})}
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
