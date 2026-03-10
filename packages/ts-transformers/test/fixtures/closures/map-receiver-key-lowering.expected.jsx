import * as __ctHelpers from "commontools";
import { pattern } from "commontools";
interface Item {
    subItems: Array<{
        value: string;
    }>;
}
interface Input {
    items: Item[];
}
const _p = pattern((__ct_pattern_input) => {
    const items = __ct_pattern_input.key("items");
    return items.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
        const item = __ct_pattern_input.key("element");
        return item.key("subItems").mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
            const subItem = __ct_pattern_input.key("element");
            return subItem.key("value");
        }, {
            type: "object",
            properties: {
                element: {
                    type: "object",
                    properties: {
                        value: {
                            type: "string"
                        }
                    },
                    required: ["value"]
                }
            },
            required: ["element"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string",
            asOpaque: true
        } as const satisfies __ctHelpers.JSONSchema), {});
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
                    subItems: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                value: {
                                    type: "string"
                                }
                            },
                            required: ["value"]
                        }
                    }
                },
                required: ["subItems"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "string"
        },
        asOpaque: true
    } as const satisfies __ctHelpers.JSONSchema), {});
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
                subItems: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            value: {
                                type: "string"
                            }
                        },
                        required: ["value"]
                    }
                }
            },
            required: ["subItems"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "array",
        items: {
            type: "string"
        }
    },
    asOpaque: true
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
