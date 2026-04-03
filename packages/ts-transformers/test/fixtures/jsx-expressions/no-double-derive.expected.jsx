import * as __cfHelpers from "commonfabric";
import { derive, pattern, UI } from "commonfabric";
interface State {
    items: {
        id: number;
        title: string;
    }[];
    cellRef: {
        name?: string;
        value: string;
    };
}
// Test case: User-written derive calls should not be double-wrapped
// This tests that derive(index, (i) => i + 1) doesn't become derive(index, index => derive(index, (i) => i + 1))
// FIXTURE: no-double-derive
// Verifies: user-written derive() calls are NOT double-wrapped in another derive()
//   derive(items.length, (n) => n + 1) → derive(schema, schema, items.length, (n) => n + 1)
//   derive(cellRef, (ref) => ref.name) → derive(schema, schema, cellRef, (ref) => ref.name)
// Context: Negative test -- prevents the transformer from wrapping already-derived expressions
export default pattern((__ct_pattern_input) => {
    const items = __ct_pattern_input.key("items");
    const cellRef = __ct_pattern_input.key("cellRef");
    return {
        [UI]: (<div>
        {/* User-written derive with simple parameter transformation - should NOT be double-wrapped */}
        <span>Count: {derive({
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, items.key("length"), (n) => n + 1)}</span>

        {/* User-written derive accessing opaque ref property - should NOT be double-wrapped */}
        <span>Name: {derive({
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            }
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, cellRef, (ref) => ref.name || "Unknown")}</span>

        {/* Nested in map with user-written derive - derives should NOT be double-wrapped */}
        {items.mapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
                const item = __ct_pattern_input.key("element");
                const index = __ct_pattern_input.key("index");
                return (<li key={item.key("id")}>
            {/* These user-written derives should remain as-is, not wrapped in another derive */}
            Item {derive({
                    type: "number"
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "number"
                } as const satisfies __cfHelpers.JSONSchema, index, (i) => i + 1)}: {derive({
                    type: "object",
                    properties: {
                        title: {
                            type: "string"
                        }
                    },
                    required: ["title"]
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __cfHelpers.JSONSchema, item, (it) => it.title)}
          </li>);
            }, {
                type: "object",
                properties: {
                    element: {
                        type: "object",
                        properties: {
                            id: {
                                type: "number"
                            },
                            title: {
                                type: "string"
                            }
                        },
                        required: ["id", "title"]
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

        {/* Simple property access - should NOT be transformed */}
        <span>Direct access: {cellRef.key("value")}</span>
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
                    id: {
                        type: "number"
                    },
                    title: {
                        type: "string"
                    }
                },
                required: ["id", "title"]
            }
        },
        cellRef: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                value: {
                    type: "string"
                }
            },
            required: ["value"]
        }
    },
    required: ["items", "cellRef"]
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
