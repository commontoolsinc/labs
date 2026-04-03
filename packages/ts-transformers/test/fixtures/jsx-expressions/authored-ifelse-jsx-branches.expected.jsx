import * as __ctHelpers from "commontools";
import { ifElse, pattern, UI, Writable } from "commontools";
interface Item {
    name: string;
}
// FIXTURE: authored-ifelse-jsx-branches
// Verifies: authored ifElse in JSX lowers both conditions and reactive branches correctly
//   ifElse(limit > 0, items.map(...), <span>Hidden</span>) → derived condition + pattern-lowered map branch
//   ifElse(show, count.get(), 0) in JSX                     → derived reactive branch, not raw count.get()
export default pattern((__ct_pattern_input) => {
    const items = __ct_pattern_input.key("items");
    const limit = __ct_pattern_input.key("limit");
    const count = __ct_pattern_input.key("count");
    const show = __ct_pattern_input.key("show");
    return ({
        [UI]: (<div>
      {ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "array",
            items: {
                $ref: "#/$defs/JSXElement"
            },
            $defs: {
                JSXElement: {
                    anyOf: [{}, {
                            type: "object",
                            properties: {}
                        }]
                }
            }
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "array",
                    items: {
                        $ref: "#/$defs/JSXElement"
                    }
                }],
            $defs: {
                JSXElement: {
                    anyOf: [{}, {
                            type: "object",
                            properties: {}
                        }]
                }
            }
        } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
            type: "object",
            properties: {
                limit: {
                    type: "number"
                }
            },
            required: ["limit"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { limit: limit }, ({ limit }) => limit > 0), items.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
            const item = __ct_pattern_input.key("element");
            return <span>{item.key("name")}</span>;
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
                        }
                    },
                    required: ["name"]
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
        } as const satisfies __ctHelpers.JSONSchema), {}), <span>Hidden</span>)}
      <p>{ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, show, __ctHelpers.derive({
            type: "object",
            properties: {
                count: {
                    type: "number",
                    asCell: true
                }
            },
            required: ["count"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { count: count }, ({ count }) => count.get()), 0)}</p>
    </div>),
    });
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        },
        limit: {
            type: "number"
        },
        count: {
            type: "number",
            asCell: true
        },
        show: {
            type: "boolean"
        }
    },
    required: ["items", "limit", "count", "show"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
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
