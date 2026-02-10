import * as __ctHelpers from "commontools";
import { cell, recipe, UI } from "commontools";
// Tests triple || chain: a || b || c
// Should produce nested unless calls
export default recipe(false as const satisfies __ctHelpers.JSONSchema, {
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
    const primary = cell("", {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema);
    const secondary = cell("", {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema);
    const items = cell<string[]>([], {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __ctHelpers.JSONSchema);
    return {
        [UI]: (<div>
        {/* Triple || chain - first truthy wins */}
        <span>{__ctHelpers.derive({
            type: "object",
            properties: {
                primary: {
                    type: "string",
                    asCell: true
                },
                secondary: {
                    type: "string",
                    asCell: true
                }
            },
            required: ["primary", "secondary"]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    type: "number"
                }, {
                    type: "string",
                    "enum": ["no content"]
                }]
        } as const satisfies __ctHelpers.JSONSchema, {
            primary: primary,
            secondary: secondary
        }, ({ primary, secondary }) => primary.get().length || secondary.get().length || "no content")}</span>

        {/* Triple || with mixed types */}
        <span>{__ctHelpers.derive({
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "string"
                    },
                    asCell: true
                }
            },
            required: ["items"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { items: items }, ({ items }) => items.get()[0]?.length || items.get()[1]?.length || 0)}</span>
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
