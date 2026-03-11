import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
// FIXTURE: pattern-with-cells
// Verifies: pattern input property access is transformed to .key() and arithmetic to derive()
//   cell.value       → cell.key("value")
//   cell.value + 1   → derive({value: asOpaque}, ({cell}) => cell.value + 1)
//   cell.value * 2   → derive({value: asOpaque}, ({cell}) => cell.value * 2)
export default pattern((cell) => {
    return {
        [UI]: (<div>
        <p>Current value: {cell.key("value")}</p>
        <p>Next value: {__ctHelpers.derive({
            type: "object",
            properties: {
                cell: {
                    type: "object",
                    properties: {
                        value: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["value"]
                }
            },
            required: ["cell"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { cell: {
                value: cell.key("value")
            } }, ({ cell }) => cell.value + 1)}</p>
        <p>Double: {__ctHelpers.derive({
            type: "object",
            properties: {
                cell: {
                    type: "object",
                    properties: {
                        value: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["value"]
                }
            },
            required: ["cell"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { cell: {
                value: cell.key("value")
            } }, ({ cell }) => cell.value * 2)}</p>
      </div>),
        value: cell.key("value"),
    };
}, {
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        },
        value: {
            type: "number",
            asOpaque: true
        }
    },
    required: ["$UI", "value"],
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
