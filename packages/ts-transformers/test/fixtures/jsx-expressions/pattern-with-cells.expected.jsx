function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
// FIXTURE: pattern-with-cells
// Verifies: pattern input property access is transformed to .key() and arithmetic to derive()
//   cell.value       → cell.key("value")
//   cell.value + 1   → derive({value: asOpaque}, ({cell}) => cell.value + 1)
//   cell.value * 2   → derive({value: asOpaque}, ({cell}) => cell.value * 2)
export default pattern((cell) => {
    return {
        [UI]: (<div>
        <p>Current value: {cell.key("value")}</p>
        <p>Next value: {__cfHelpers.derive({
            type: "object",
            properties: {
                cell: {
                    type: "object",
                    properties: {
                        value: {
                            type: "number"
                        }
                    },
                    required: ["value"]
                }
            },
            required: ["cell"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { cell: {
                value: cell.key("value")
            } }, ({ cell }) => cell.value + 1)}</p>
        <p>Double: {__cfHelpers.derive({
            type: "object",
            properties: {
                cell: {
                    type: "object",
                    properties: {
                        value: {
                            type: "number"
                        }
                    },
                    required: ["value"]
                }
            },
            required: ["cell"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { cell: {
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
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        },
        value: {
            type: "number"
        }
    },
    required: ["$UI", "value"],
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
__ctHardenFn(h);
