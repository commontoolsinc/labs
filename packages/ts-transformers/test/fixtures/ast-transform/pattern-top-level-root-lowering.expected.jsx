import * as __ctHelpers from "commontools";
import { pattern } from "commontools";
const identity = <T,>(value: T) => value;
// FIXTURE: pattern-top-level-root-lowering
// Verifies: top-level non-JSX ordinary helper calls with reactive inputs are
//   lifted as whole calls instead of lowering only inner argument expressions.
//   identity(state.user.name)     -> derive-wrapped local-helper root
//   identity(state.maybeUser?.name) -> derive-wrapped optional property access
//   Math.max(state.a, state.b)    -> derive-wrapped free-function root
//   parseInt(state.float)         -> derive-wrapped free-function root
//   state.label ?? "Pending"      -> derive-wrapped nullish root
//   state.items?.[0]              -> lowered optional element access
export default pattern((state) => {
    const label = __ctHelpers.derive({
        type: "object",
        properties: {
            state: {
                type: "object",
                properties: {
                    user: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            }
                        },
                        required: ["name"]
                    }
                },
                required: ["user"]
            }
        },
        required: ["state"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema, { state: {
            user: {
                name: state.key("user", "name")
            }
        } }, ({ state }) => identity(state.user.name));
    const maybeLabel = __ctHelpers.derive({
        type: "object",
        properties: {
            state: {
                type: "object",
                properties: {
                    maybeUser: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            }
                        },
                        required: ["name"]
                    }
                }
            }
        },
        required: ["state"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: ["string", "undefined"]
    } as const satisfies __ctHelpers.JSONSchema, { state: {
            maybeUser: state.key("maybeUser")
        } }, ({ state }) => identity(state.maybeUser?.name));
    return {
        label,
        maybeLabel,
        maxValue: __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        a: {
                            type: "number"
                        },
                        b: {
                            type: "number"
                        }
                    },
                    required: ["a", "b"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                a: state.key("a"),
                b: state.key("b")
            } }, ({ state }) => Math.max(state.a, state.b)),
        parsedValue: __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        float: {
                            type: "string"
                        }
                    },
                    required: ["float"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                float: state.key("float")
            } }, ({ state }) => parseInt(state.float)),
        fallbackLabel: __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        label: {
                            type: ["null", "string", "undefined"]
                        }
                    }
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                label: state.key("label")
            } }, ({ state }) => state.label ?? "Pending"),
        firstItem: state.key("items", "0"),
    };
}, {
    type: "object",
    properties: {
        user: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        },
        maybeUser: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        },
        a: {
            type: "number"
        },
        b: {
            type: "number"
        },
        float: {
            type: "string"
        },
        label: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "null"
                }]
        },
        items: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["user", "a", "b", "float"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        label: {
            type: "string"
        },
        maybeLabel: {
            type: ["string", "undefined"]
        },
        maxValue: {
            type: "number"
        },
        parsedValue: {
            type: "number"
        },
        fallbackLabel: {
            type: "string"
        },
        firstItem: {
            type: ["string", "undefined"]
        }
    },
    required: ["label", "maybeLabel", "maxValue", "parsedValue", "fallbackLabel", "firstItem"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
