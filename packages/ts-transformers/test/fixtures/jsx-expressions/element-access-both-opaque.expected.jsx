import * as __ctHelpers from "commontools";
import { cell, pattern, UI } from "commontools";
export default pattern(false as const satisfies __ctHelpers.JSONSchema, {
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
} as const satisfies __ctHelpers.JSONSchema, (_state) => {
    const items = cell(["apple", "banana", "cherry"], {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __ctHelpers.JSONSchema);
    const index = cell(1, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    return {
        [UI]: (<div>
        <h3>Element Access with Both OpaqueRefs</h3>
        {/* Both items and index are OpaqueRefs */}
        <p>Selected item: {__ctHelpers.derive({
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "string"
                    },
                    asCell: true
                },
                index: {
                    type: "number",
                    asCell: true
                }
            },
            required: ["items", "index"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            items: items,
            index: index
        }, ({ items, index }) => items.get()[index.get()])}</p>
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
