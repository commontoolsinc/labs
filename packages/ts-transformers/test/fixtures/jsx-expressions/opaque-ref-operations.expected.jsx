import * as __ctHelpers from "commontools";
import { cell, pattern, UI } from "commontools";
export default pattern((_state) => {
    const count = cell(10, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const price = cell(10, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    return {
        [UI]: (<div>
        <p>Count: {count}</p>
        <p>Next: {__ctHelpers.derive({
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
        } as const satisfies __ctHelpers.JSONSchema, { count: count }, ({ count }) => count.get() + 1)}</p>
        <p>Double: {__ctHelpers.derive({
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
        } as const satisfies __ctHelpers.JSONSchema, { count: count }, ({ count }) => count.get() * 2)}</p>
        <p>Total: {__ctHelpers.derive({
            type: "object",
            properties: {
                price: {
                    type: "number",
                    asCell: true
                }
            },
            required: ["price"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { price: price }, ({ price }) => price.get() * 1.1)}</p>
      </div>),
    };
}, false as const satisfies __ctHelpers.JSONSchema, {
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
