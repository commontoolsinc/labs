import * as __ctHelpers from "commontools";
import { derive, pattern, UI } from "commontools";
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
export default pattern((__ct_pattern_input) => {
    const items = __ct_pattern_input.key("items");
    const cellRef = __ct_pattern_input.key("cellRef");
    return {
        [UI]: (<div>
        {/* User-written derive with simple parameter transformation - should NOT be double-wrapped */}
        <span>Count: {derive({
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, items.key("length"), (n) => n + 1)}</span>

        {/* User-written derive accessing opaque ref property - should NOT be double-wrapped */}
        <span>Name: {derive({
            type: "object",
            properties: {
                name: {
                    anyOf: [{
                            type: "string"
                        }, {
                            type: "undefined"
                        }]
                }
            }
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, cellRef, (ref) => ref.name || "Unknown")}</span>

        {/* Nested in map with user-written derive - derives should NOT be double-wrapped */}
        {items.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const item = __ct_pattern_input.key("element");
                const index = __ct_pattern_input.key("index");
                return (<li key={item.key("id")}>
            {/* These user-written derives should remain as-is, not wrapped in another derive */}
            Item {derive({
                    type: "number"
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "number"
                } as const satisfies __ctHelpers.JSONSchema, index, (i) => i + 1)}: {derive({
                    type: "object",
                    properties: {
                        title: {
                            type: "string"
                        }
                    },
                    required: ["title"]
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __ctHelpers.JSONSchema, item, (it) => it.title)}
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
            } as const satisfies __ctHelpers.JSONSchema, {
                anyOf: [{
                        $ref: "https://commonfabric.org/schemas/vnode.json"
                    }, {
                        type: "object",
                        properties: {}
                    }, {
                        $ref: "#/$defs/UIRenderable",
                        asOpaque: true
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
                    $ref: "#/$defs/UIRenderable",
                    asOpaque: true
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
