function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { cell, NAME, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: optional-element-access
// Verifies: optional element access (?.[0]) in a negated && guard is transformed to when(derive(...))
//   !list.get()?.[0] && <span> → when(derive({list}, ({list}) => !list.get()?.[0]), <span>)
// Context: Cell typed as string[] | undefined, with optional bracket access
export default pattern(() => {
    const list = cell<string[] | undefined>(undefined, {
        anyOf: [{
                type: "undefined"
            }, {
                type: "array",
                items: {
                    type: "string"
                }
            }]
    } as const satisfies __cfHelpers.JSONSchema).for("list", true);
    return {
        [NAME]: "Optional element access",
        [UI]: (<div>
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
                list: {
                    anyOf: [{
                            type: "undefined"
                        }, {
                            type: "array",
                            items: {
                                type: "string"
                            }
                        }],
                    asCell: ["cell"]
                }
            },
            required: ["list"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, { list: list }, ({ list }) => !list.get()?.[0]), <span>No first entry</span>)}
      </div>),
    };
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string"
        },
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$NAME", "$UI"],
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
