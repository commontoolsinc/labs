import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
const identity = <T,>(value: T) => value;
// FIXTURE: map-receiver-method-roots
// Verifies: receiver-method roots inside pattern-owned map callbacks lower reactively
//   item.toUpperCase()            → callback-local derive
//   identity(item.toUpperCase())  → call-argument receiver-method root lowered reactively
export default pattern((__ct_pattern_input) => {
    const items = __ct_pattern_input.key("items");
    return ({
        [UI]: (<div>
      {items.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
            const item = __ct_pattern_input.key("element");
            return <span>{__ctHelpers.derive({
                type: "object",
                properties: {
                    item: {
                        type: "string"
                    }
                },
                required: ["item"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __ctHelpers.JSONSchema, { item: item }, ({ item }) => item.toUpperCase())}</span>;
        }, {
            type: "object",
            properties: {
                element: {
                    type: "string"
                }
            },
            required: ["element"]
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
        } as const satisfies __ctHelpers.JSONSchema), {})}
      {items.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
            const item = __ct_pattern_input.key("element");
            return <span>{__ctHelpers.derive({
                type: "object",
                properties: {
                    item: {
                        type: "string"
                    }
                },
                required: ["item"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __ctHelpers.JSONSchema, { item: item }, ({ item }) => identity(item.toUpperCase()))}</span>;
        }, {
            type: "object",
            properties: {
                element: {
                    type: "string"
                }
            },
            required: ["element"]
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
        } as const satisfies __ctHelpers.JSONSchema), {})}
    </div>),
    });
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["items"]
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
