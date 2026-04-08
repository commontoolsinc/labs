function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { cell, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
// Tests triple && chain: a && b && c
// Should produce nested when calls or derive the entire chain
// FIXTURE: logical-triple-and-chain
// Verifies: triple && chain (a && b && <JSX>) is transformed to nested when() or derive()
//   user.get().active && user.get().verified && <span> → when(derive({user}, ...), <span>)
export default pattern((_state) => {
    const user = cell<{
        active: boolean;
        verified: boolean;
        name: string;
    }>({ active: false, verified: false, name: "" }, {
        type: "object",
        properties: {
            active: {
                type: "boolean"
            },
            verified: {
                type: "boolean"
            },
            name: {
                type: "string"
            }
        },
        required: ["active", "verified", "name"]
    } as const satisfies __cfHelpers.JSONSchema);
    return {
        [UI]: (<div>
        {/* Triple && chain with complex conditions */}
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
                user: {
                    type: "object",
                    properties: {
                        active: {
                            type: "boolean"
                        },
                        verified: {
                            type: "boolean"
                        },
                        name: {
                            type: "string"
                        }
                    },
                    required: ["active", "verified", "name"],
                    asCell: true
                }
            },
            required: ["user"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, { user: user }, ({ user }) => user.get().active && user.get().verified), <span>Welcome, {__cfHelpers.derive({
            type: "object",
            properties: {
                user: {
                    type: "object",
                    properties: {
                        active: {
                            type: "boolean"
                        },
                        verified: {
                            type: "boolean"
                        },
                        name: {
                            type: "string"
                        }
                    },
                    required: ["active", "verified", "name"],
                    asCell: true
                }
            },
            required: ["user"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { user: user }, ({ user }) => user.get().name)}!</span>)}
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
