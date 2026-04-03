import * as __cfHelpers from "commonfabric";
import { pattern, UI } from "commonfabric";
const identity = <T,>(value: T) => value;
// FIXTURE: map-receiver-method-roots
// Verifies: receiver-method roots inside pattern-owned map callbacks lower reactively
//   item.toUpperCase()            → callback-local derive
//   identity(item.toUpperCase())  → call-argument receiver-method root lowered reactively
export default pattern((__ct_pattern_input) => {
    const items = __ct_pattern_input.key("items");
    return ({
        [UI]: (<div>
      {items.mapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
            const item = __ct_pattern_input.key("element");
            return <span>{__cfHelpers.derive({
                type: "object",
                properties: {
                    item: {
                        type: "string"
                    }
                },
                required: ["item"]
            } as const satisfies __cfHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __cfHelpers.JSONSchema, { item: item }, ({ item }) => item.toUpperCase())}</span>;
        }, {
            type: "object",
            properties: {
                element: {
                    type: "string"
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
      {items.mapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
            const item = __ct_pattern_input.key("element");
            return <span>{__cfHelpers.derive({
                type: "object",
                properties: {
                    item: {
                        type: "string"
                    }
                },
                required: ["item"]
            } as const satisfies __cfHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __cfHelpers.JSONSchema, { item: item }, ({ item }) => identity(item.toUpperCase()))}</span>;
        }, {
            type: "object",
            properties: {
                element: {
                    type: "string"
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
