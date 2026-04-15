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
// Tests mixed && and || operators: (a && b) || c
// The && should use when, the || should use unless
// FIXTURE: logical-mixed-and-or
// Verifies: mixed && and || patterns are correctly decomposed into when/unless/derive
//   (cond && value) || fallback → derive or nested when/unless
//   cond && (value || fallback) → nested logical transforms
//   (a && b) || (c && d) || e   → chained derive expressions
export default pattern((_state) => {
    const user = cell<{
        name: string;
        age: number;
    }>({ name: "", age: 0 }, {
        type: "object",
        properties: {
            name: {
                type: "string"
            },
            age: {
                type: "number"
            }
        },
        required: ["name", "age"]
    } as const satisfies __cfHelpers.JSONSchema).for("user", true);
    const defaultMessage = cell("Guest", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema).for("defaultMessage", true);
    return {
        [UI]: (<div>
        {/* (condition && value) || fallback pattern */}
        <span>{__cfHelpers.unless({
            type: ["boolean", "string"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
            type: "object",
            properties: {
                user: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        },
                        age: {
                            type: "number"
                        }
                    },
                    required: ["name", "age"],
                    asCell: ["cell"]
                }
            },
            required: ["user"]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{
                    type: "string"
                }, {
                    type: "boolean",
                    "enum": [false]
                }]
        } as const satisfies __cfHelpers.JSONSchema, { user: user }, ({ user }) => (user.get().name.length > 0 && user.get().name)), __cfHelpers.derive({
            type: "object",
            properties: {
                defaultMessage: {
                    type: "string",
                    asCell: ["cell"]
                }
            },
            required: ["defaultMessage"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { defaultMessage: defaultMessage }, ({ defaultMessage }) => defaultMessage.get()))}</span>

        {/* condition && (value || fallback) pattern */}
        <span>{__cfHelpers.when({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: ["boolean", "string"]
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
            type: "object",
            properties: {
                user: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        },
                        age: {
                            type: "number"
                        }
                    },
                    required: ["name", "age"],
                    asCell: ["cell"]
                }
            },
            required: ["user"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, { user: user }, ({ user }) => user.get().age > 18), __cfHelpers.unless({
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
            type: "object",
            properties: {
                user: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        },
                        age: {
                            type: "number"
                        }
                    },
                    required: ["name", "age"],
                    asCell: ["cell"]
                }
            },
            required: ["user"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { user: user }, ({ user }) => user.get().name), "Anonymous Adult"))}</span>

        {/* Complex: (a && b) || (c && d) */}
        <span>
          {__cfHelpers.unless({
            type: ["boolean", "string"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
            type: "object",
            properties: {
                user: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        },
                        age: {
                            type: "number"
                        }
                    },
                    required: ["name", "age"],
                    asCell: ["cell"]
                }
            },
            required: ["user"]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{
                    type: "string"
                }, {
                    type: "boolean",
                    "enum": [false]
                }]
        } as const satisfies __cfHelpers.JSONSchema, { user: user }, ({ user }) => (user.get().name.length > 0 && `Hello ${user.get().name}`) ||
            (user.get().age > 0 && `Age: ${user.get().age}`)), "Unknown user")}
        </span>
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
