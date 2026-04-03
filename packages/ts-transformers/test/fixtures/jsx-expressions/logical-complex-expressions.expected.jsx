import * as __cfHelpers from "commonfabric";
import { cell, pattern, UI } from "commonfabric";
// FIXTURE: logical-complex-expressions
// Verifies: nested && and mixed || && with JSX are transformed to when() with derive() predicates
//   a && b && <JSX>     → when(derive({a, b}, ...), <JSX>)
//   (a || b) && <JSX>   → when(derive({a, b}, ...), <JSX>)
export default pattern((_state) => {
    const items = cell<string[]>([], {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __cfHelpers.JSONSchema);
    const isEnabled = cell(false, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema);
    const count = cell(0, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    return {
        [UI]: (<div>
        {/* Nested && - both conditions reference opaque refs */}
        {__cfHelpers.when({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{
                    type: "boolean"
                }, {}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "unknown"
                    },
                    asCell: true
                },
                isEnabled: {
                    type: "boolean",
                    asCell: true
                }
            },
            required: ["items", "isEnabled"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            items: items,
            isEnabled: isEnabled
        }, ({ items, isEnabled }) => items.get().length > 0 && isEnabled.get()), <div>Enabled with items</div>)}

        {/* Mixed || and && */}
        {__cfHelpers.when({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{
                    type: "boolean"
                }, {}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
            type: "object",
            properties: {
                count: {
                    type: "number",
                    asCell: true
                },
                items: {
                    type: "array",
                    items: {
                        type: "unknown"
                    },
                    asCell: true
                }
            },
            required: ["count", "items"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            count: count,
            items: items
        }, ({ count, items }) => (count.get() > 10 || items.get().length > 5)), <div>Threshold met</div>)}
      </div>),
    };
}, false as const satisfies __cfHelpers.JSONSchema, {
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
