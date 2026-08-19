function __cfBindVerifiedBinding(value: any, metadata: any) {
    if (value && (typeof value === "object" || typeof value === "function") && Object.isExtensible(value)) {
        Object.defineProperty(value, "__cfVerifiedBindingIdentity", {
            value: metadata,
            configurable: true
        });
    }
    if (value && (typeof value === "object" || typeof value === "function") && typeof value.implementation === "function") {
        var implementation = value.implementation;
        if (implementation && (typeof implementation === "object" || typeof implementation === "function") && Object.isExtensible(implementation)) {
            Object.defineProperty(implementation, "__cfVerifiedBindingIdentity", {
                value: metadata,
                configurable: true
            });
        }
    }
    return value;
}
function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, type Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface AuthData {
    token: string;
    user: {
        email: string;
    };
}
type AuthCell = Writable<AuthData>;
type AuthAvailability = {
    state: "loading";
    auth: null;
} | {
    state: "ready";
    auth: AuthCell;
};
interface Input {
    availability: AuthAvailability;
}
// FIXTURE: auth-availability-union-cell-preserved
// A discriminated union can represent loading auth separately from ready auth.
// The ready variant keeps the nested auth value as a live writable cell.
export default __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const availability = __cf_pattern_input.key("availability");
    return {
        availability,
    };
}, {
    type: "object",
    properties: {
        availability: {
            $ref: "#/$defs/AuthAvailability"
        }
    },
    required: ["availability"],
    $defs: {
        AuthAvailability: {
            anyOf: [{
                    type: "object",
                    properties: {
                        state: {
                            type: "string",
                            "enum": ["loading"]
                        },
                        auth: {
                            type: "null"
                        }
                    },
                    required: ["state", "auth"]
                }, {
                    type: "object",
                    properties: {
                        state: {
                            type: "string",
                            "enum": ["ready"]
                        },
                        auth: {
                            $ref: "#/$defs/AuthData",
                            asCell: ["cell"]
                        }
                    },
                    required: ["state", "auth"]
                }]
        },
        AuthData: {
            type: "object",
            properties: {
                token: {
                    type: "string"
                },
                user: {
                    type: "object",
                    properties: {
                        email: {
                            type: "string"
                        }
                    },
                    required: ["email"]
                }
            },
            required: ["token", "user"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        availability: {
            $ref: "#/$defs/AuthAvailability"
        }
    },
    required: ["availability"],
    $defs: {
        AuthAvailability: {
            anyOf: [{
                    type: "object",
                    properties: {
                        state: {
                            type: "string",
                            "enum": ["loading"]
                        },
                        auth: {
                            type: "null"
                        }
                    },
                    required: ["state", "auth"]
                }, {
                    type: "object",
                    properties: {
                        state: {
                            type: "string",
                            "enum": ["ready"]
                        },
                        auth: {
                            $ref: "#/$defs/AuthData",
                            asCell: ["cell"]
                        }
                    },
                    required: ["state", "auth"]
                }]
        },
        AuthData: {
            type: "object",
            properties: {
                token: {
                    type: "string"
                },
                user: {
                    type: "object",
                    properties: {
                        email: {
                            type: "string"
                        }
                    },
                    required: ["email"]
                }
            },
            required: ["token", "user"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 24, col: 30 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
