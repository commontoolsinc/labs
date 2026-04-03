import * as __ctHelpers from "commontools";
import { cell, pattern, UI } from "commontools";
// FIXTURE: reactive-array-element-access-schema
// Verifies: reactive array element access preserves `string | undefined` in the
// emitted result schema.
export default pattern((_state) => {
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
        [UI]: <div>{__ctHelpers.derive({
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
            type: ["string", "undefined"]
        } as const satisfies __ctHelpers.JSONSchema, {
            items: items,
            index: index
        }, ({ items, index }) => items.get()[index.get()])}</div>,
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
