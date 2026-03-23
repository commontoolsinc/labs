import * as __ctHelpers from "commontools";
import { computed, pattern, UI } from "commontools";
interface Item {
    done: boolean;
}
interface State {
    items: Item[];
}
// FIXTURE: computed-map-direct-return-conditional
// Verifies: direct callback-return ternary on a computed array is lowered to ifElse()
//   rows.map((row) => row.done ? "Done" : "Pending")
//   → rows.mapWithPattern(pattern(... return ifElse(row.done, "Done", "Pending")))
// Context: the conditional is the callback's root return expression, not nested
//   inside returned JSX, which currently slips past the JSX-local rewrite pass.
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
            return __ctHelpers.ifElse({
                type: "boolean"
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __ctHelpers.JSONSchema, {
                "enum": ["Done", "Pending"]
            } as const satisfies __ctHelpers.JSONSchema, row.key("done"), "Done", "Pending");
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
            "enum": ["Done", "Pending"]
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
