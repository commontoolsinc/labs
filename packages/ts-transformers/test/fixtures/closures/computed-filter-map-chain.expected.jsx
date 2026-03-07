import * as __ctHelpers from "commontools";
import { computed, pattern, UI } from "commontools";
interface Item {
    name: string;
    active: boolean;
}
interface State {
    items: Item[];
}
// FIXTURE: computed-filter-map-chain
// Verifies: .filter().map() chain inside computed() is NOT transformed
// Context: Inside computed(), OpaqueRef auto-unwraps to plain values, so
//   .filter() returns a plain JS array and .map() is Array.prototype.map.
//   Neither should become WithPattern variants. Same logic as derive.
export default pattern((state) => {
    const names = __ctHelpers.derive({
        type: "object",
        properties: {
            state: {
                type: "object",
                properties: {
                    items: {
                        type: "array",
                        items: {
                            $ref: "#/$defs/Item"
                        },
                        asOpaque: true
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
                    name: {
                        type: "string"
                    },
                    active: {
                        type: "boolean"
                    }
                },
                required: ["name", "active"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "string",
            asOpaque: true
        }
    } as const satisfies __ctHelpers.JSONSchema, { state: {
            items: state.items
        } }, ({ state }) => state.items
        .filter((item) => item.active)
        .map((item) => item.name));
    return {
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
                active: {
                    type: "boolean"
                }
            },
            required: ["name", "active"]
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
