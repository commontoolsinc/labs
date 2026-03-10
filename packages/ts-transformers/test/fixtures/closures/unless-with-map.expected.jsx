import * as __ctHelpers from "commontools";
/**
 * Test case for unless() with a reactive array map as the fallback.
 *
 * unless(condition, fallback) returns condition if truthy, else fallback.
 * When fallback is items.map(...), the map gets transformed to mapWithPattern.
 * Schema injection needs to know the type of the mapWithPattern result.
 */
import { Cell, Default, pattern, UI } from "commontools";
interface Item {
    label: string;
}
interface PatternInput {
    customContent: Cell<any>;
    items: Cell<Default<Item[], [
    ]>>;
}
export default pattern((__ct_pattern_input) => {
    const customContent = __ct_pattern_input.key("customContent");
    const items = __ct_pattern_input.key("items");
    return {
        [UI]: (<div>
        {/* unless(condition, fallback) where fallback is a reactive map */}
        {__ctHelpers.unless({
            asCell: true
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "array",
            items: {}
        } as const satisfies __ctHelpers.JSONSchema, {
            asCell: true
        } as const satisfies __ctHelpers.JSONSchema, customContent, items.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
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
        } as const satisfies __ctHelpers.JSONSchema), {}))}
      </div>),
    };
}, {
    type: "object",
    properties: {
        customContent: {
            asCell: true
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
    required: ["customContent", "items"],
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
