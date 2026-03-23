import * as __ctHelpers from "commontools";
import { computed, pattern, UI } from "commontools";
interface Item {
    done: boolean;
}
interface State {
    items: Item[];
}
// FIXTURE: computed-map-local-object-conditional
// Verifies: nested ternary inside a callback-local object initializer within a
//   computed-array .map() callback is lowered to ifElse().
//   const view = { status: row.done ? "Done" : "Pending" }
//   → const view = { status: ifElse(row.done, "Done", "Pending") }
export default pattern((state) => {
    const rows = __ctHelpers.derive({
        type: "object",
        properties: {
            state: {
                type: "object",
                properties: {
                    items: {
                        type: "array",
                        items: {
                            $ref: "#/$defs/Item"
                        }
                    }
                },
                required: ["items"]
            }
        },
        required: ["state"],
        $defs: {
            Item: {
                type: "object",
                properties: {
                    done: {
                        type: "boolean"
                    }
                },
                required: ["done"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            $ref: "#/$defs/Item"
        },
        $defs: {
            Item: {
                type: "object",
                properties: {
                    done: {
                        type: "boolean"
                    }
                },
                required: ["done"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, { state: {
            items: state.key("items")
        } }, ({ state }) => state.items);
    return {
        [UI]: (<div>
        {rows.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const row = __ct_pattern_input.key("element");
                const view = { status: __ctHelpers.ifElse({
                        type: "boolean"
                    } as const satisfies __ctHelpers.JSONSchema, {
                        type: "string"
                    } as const satisfies __ctHelpers.JSONSchema, {
                        type: "string"
                    } as const satisfies __ctHelpers.JSONSchema, {
                        "enum": ["Done", "Pending"]
                    } as const satisfies __ctHelpers.JSONSchema, row.key("done"), "Done", "Pending") };
                return <span>{view.status}</span>;
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
                            done: {
                                type: "boolean"
                            }
                        },
                        required: ["done"]
                    }
                }
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
            } as const satisfies __ctHelpers.JSONSchema), {})}
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
    required: ["items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                done: {
                    type: "boolean"
                }
            },
            required: ["done"]
        }
    }
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
