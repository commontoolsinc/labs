function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfModuleCallback_1 = __cfHardenFn(({ state }) => identity(state.user.name));
const __cfModuleCallback_2 = __cfHardenFn(({ state }) => identity(state.maybeUser?.name));
const identity = __cfHardenFn(<T,>(value: T) => value);
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
    const label = __cfHelpers.lift<{
        state: {
            user: {
                name: string;
            };
        };
    }, string>({
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
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, __cfModuleCallback_1)({ state: {
            user: {
                name: state.key("user", "name")
            }
        } }).for("label", true);
    const maybeLabel = __cfHelpers.lift<{
        state: {
            maybeUser?: { name: string; } | undefined;
        };
    }, string | undefined>({
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
    } as const satisfies __cfHelpers.JSONSchema, {
        type: ["string", "undefined"]
    } as const satisfies __cfHelpers.JSONSchema, __cfModuleCallback_2)({ state: {
            maybeUser: state.key("maybeUser")
        } }).for("maybeLabel", true);
    return {
        label,
        maybeLabel,
        maxValue: __cfHelpers.lift<{
            state: {
                a: number;
                b: number;
            };
        }, number>({
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, ({ state }) => Math.max(state.a, state.b))({ state: {
                a: state.key("a"),
                b: state.key("b")
            } }).for(["__patternResult", "maxValue"], true),
        parsedValue: __cfHelpers.lift<{
            state: {
                float: string;
            };
        }, number>({
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, ({ state }) => parseInt(state.float))({ state: {
                float: state.key("float")
            } }).for(["__patternResult", "parsedValue"], true),
        fallbackLabel: __cfHelpers.lift<{
            state: {
                label?: string | null | undefined;
            };
        }, string>({
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, ({ state }) => state.label ?? "Pending")({ state: {
                label: state.key("label")
            } }).for(["__patternResult", "fallbackLabel"], true),
        firstItem: state.key("items", "0")
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
} as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
