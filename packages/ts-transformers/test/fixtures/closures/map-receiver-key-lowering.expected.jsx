function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
interface Item {
    subItems: Array<{
        value: string;
    }>;
}
interface Input {
    items: Item[];
}
// FIXTURE: map-receiver-key-lowering
// Verifies: nested .map() calls are both transformed, with receiver lowered to .key()
//   items.map(fn) → items.mapWithPattern(pattern(...), {})
//   item.subItems.map(fn) → item.key("subItems").mapWithPattern(pattern(...), {})
// Context: No captures; receiver expression item.subItems is lowered to item.key("subItems")
const _p = pattern((__ct_pattern_input) => {
    const items = __ct_pattern_input.key("items");
    return items.mapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
        const item = __ct_pattern_input.key("element");
        return item.key("subItems").mapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema), {});
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
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __cfHelpers.JSONSchema), {});
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
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "array",
        items: {
            type: "string"
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__ctHardenFn(h);
