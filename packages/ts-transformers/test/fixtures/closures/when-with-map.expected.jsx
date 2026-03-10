import * as __ctHelpers from "commontools";
/**
 * Test case for when() with a reactive array map as the value.
 *
 * when(condition, value) returns value if condition is truthy, else condition.
 * When value is items.map(...), the map gets transformed to mapWithPattern.
 * Schema injection needs to know the type of the mapWithPattern result.
 */
import { Cell, Default, pattern, UI } from "commontools";
interface Item {
    label: string;
}
interface PatternInput {
    showItems: boolean;
    items: Cell<Default<Item[], [
    ]>>;
}
// FIXTURE: when-with-map
// Verifies: && operator becomes when() with reactive map as the value
//   showItems && items.map(...) → when(showItems, items.mapWithPattern(...))
//   items.map((item) => ...) → items.mapWithPattern(pattern(...))
// Context: when(condition, value) returns value if condition is truthy, else
//   condition. The value branch contains a reactive .map() that must be
//   transformed to mapWithPattern with proper schema injection.
export default pattern((__ct_pattern_input) => {
    const showItems = __ct_pattern_input.key("showItems");
    const items = __ct_pattern_input.key("items");
    return {
        [UI]: (<div>
        {/* when(condition, value) where value is a reactive map */}
        {__ctHelpers.when({
            type: "boolean",
            asOpaque: true
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "array",
            items: {
                $ref: "#/$defs/UIRenderable"
            },
            asOpaque: true,
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
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "array",
            items: {
                $ref: "#/$defs/UIRenderable"
            },
            asOpaque: true,
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
        } as const satisfies __ctHelpers.JSONSchema, showItems, items.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
            const item = __ct_pattern_input.key("element");
            return <li>{item.key("label")}</li>;
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
                        label: {
                            type: "string"
                        }
                    },
                    required: ["label"]
                }
            }
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
        } as const satisfies __ctHelpers.JSONSchema), {}))}
      </div>),
    };
}, {
    type: "object",
    properties: {
        showItems: {
            type: "boolean"
        },
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            "default": [],
            asCell: true
        }
    },
    required: ["showItems", "items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                }
            },
            required: ["label"]
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
