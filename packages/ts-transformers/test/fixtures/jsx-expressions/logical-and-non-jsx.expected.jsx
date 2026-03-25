import * as __cfHelpers from "commonfabric";
import { cell, pattern, UI } from "commonfabric";
// FIXTURE: logical-and-non-jsx
// Verifies: && with non-JSX right side still lowers through when(), with predicate/value derived separately
//   user.get().name.length > 0 && `Hello...` → when(derive(predicate), derive(template))
//   user.get().age > 18 && user.get().age    → when(derive(predicate), derive(number))
// Context: JSX-local control flow still uses when(); non-JSX right-hand values become derived branch values
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
    } as const satisfies __cfHelpers.JSONSchema);
    return {
        [UI]: (<div>
        {/* Non-JSX right side: string template with complex expression */}
        <p>{__cfHelpers.when({
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
                        }
                    },
                    required: ["name"],
                    asCell: true
                }
            },
            required: ["user"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, { user: user }, ({ user }) => user.get().name.length > 0), __cfHelpers.derive({
            type: "object",
            properties: {
                user: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        }
                    },
                    required: ["name"],
                    asCell: true
                }
            },
            required: ["user"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { user: user }, ({ user }) => `Hello, ${user.get().name}!`))}</p>

        {/* Non-JSX right side: number expression */}
        <p>Age: {__cfHelpers.when({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: ["boolean", "number"]
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
            type: "object",
            properties: {
                user: {
                    type: "object",
                    properties: {
                        age: {
                            type: "number"
                        }
                    },
                    required: ["age"],
                    asCell: true
                }
            },
            required: ["user"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, { user: user }, ({ user }) => user.get().age > 18), __cfHelpers.derive({
            type: "object",
            properties: {
                user: {
                    type: "object",
                    properties: {
                        age: {
                            type: "number"
                        }
                    },
                    required: ["age"],
                    asCell: true
                }
            },
            required: ["user"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { user: user }, ({ user }) => user.get().age))}</p>
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
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
