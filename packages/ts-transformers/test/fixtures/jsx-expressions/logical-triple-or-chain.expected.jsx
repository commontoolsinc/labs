function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { cell, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// Tests triple || chain: a || b || c
// Should produce nested unless calls
// FIXTURE: logical-triple-or-chain
// Verifies: triple || chain (a || b || c) is transformed to nested unless() calls
//   primary.get().length || secondary.get().length || "no content" → unless(unless(...), "no content")
export default pattern((_state) => {
    const primary = cell("", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema);
    const secondary = cell("", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema);
    const items = cell<string[]>([], {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __cfHelpers.JSONSchema);
    return {
        [UI]: (<div>
        {/* Triple || chain - first truthy wins */}
        <span>{__cfHelpers.unless({
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: ["number", "string"]
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, {
            primary: primary,
            secondary: secondary
        }, ({ primary, secondary }) => primary.get().length || secondary.get().length), "no content")}</span>

        {/* Triple || with mixed types */}
        <span>{__cfHelpers.unless({
            type: ["number", "undefined"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: ["number", "undefined"]
        } as const satisfies __cfHelpers.JSONSchema, { items: items }, ({ items }) => items.get()[0]?.length || items.get()[1]?.length), 0)}</span>
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
__cfHardenFn(h);
