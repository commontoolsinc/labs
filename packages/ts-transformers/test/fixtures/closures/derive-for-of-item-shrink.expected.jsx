import * as __ctHelpers from "commontools";
import { derive, pattern, UI, NAME } from "commontools";
interface Item {
    name: string;
    category: string;
    price: number;
}
// FIXTURE: derive-for-of-item-shrink
// Verifies: derive() callbacks using for...of can shrink array item schemas to
//   only the item properties that are actually read.
// Context: after OpaqueRef became transparent at the type level, iterating an
//   Item[] and only reading item.name should emit an input schema that narrows
//   items to { name: string }[] rather than keeping the full Item surface.
export default pattern((__ct_pattern_input) => {
    const items = __ct_pattern_input.key("items");
    const names = derive({
        type: "object",
        properties: {
            items: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        }
                    },
                    required: ["name"]
                }
            }
        },
        required: ["items"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __ctHelpers.JSONSchema, { items }, ({ items }) => {
        const result: string[] = [];
        for (const item of items) {
            result.push(item.name);
        }
        return result;
    });
    return {
        [NAME]: "test",
        [UI]: <div>{names}</div>,
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
                name: {
                    type: "string"
                },
                category: {
                    type: "string"
                },
                price: {
                    type: "number"
                }
            },
            required: ["name", "category", "price"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string"
        },
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$NAME", "$UI"],
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
