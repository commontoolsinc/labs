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
import { pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    wishes: [
        {
            id: string;
            status: string;
        },
        {
            id: string;
            status: string;
        }
    ];
}
const __cfLift_1 = __cfHelpers.lift<{
    state: {
        wishes: [{ id: string; status: string; }, { id: string; status: string; }];
    };
}, string>(({ state }) => JSON.stringify(state.wishes[1]), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                wishes: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            id: {
                                type: "string"
                            },
                            status: {
                                type: "string"
                            }
                        },
                        required: ["id", "status"]
                    }
                }
            },
            required: ["wishes"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 14, col: 14 }
});
const __cfLift_2 = __cfHelpers.lift<{
    state: {
        wishes: [{ id: string; status: string; }, { id: string; status: string; }];
    };
}, string[]>(({ state }) => Object.keys(state.wishes[1]), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                wishes: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            id: {
                                type: "string"
                            },
                            status: {
                                type: "string"
                            }
                        },
                        required: ["id", "status"]
                    }
                }
            },
            required: ["wishes"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfLift_2, {
    sourceFile: "/test.tsx",
    position: { line: 15, col: 8 }
});
const __cfLift_3 = __cfHelpers.lift<{
    state: {
        wishes: [{ id: string; status: string; }, { id: string; status: string; }];
    };
}, string[]>(({ state }) => Object.values(state.wishes[1]), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                wishes: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            id: {
                                type: "string"
                            },
                            status: {
                                type: "string"
                            }
                        },
                        required: ["id", "status"]
                    }
                }
            },
            required: ["wishes"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfLift_3, {
    sourceFile: "/test.tsx",
    position: { line: 16, col: 10 }
});
const __cfLift_4 = __cfHelpers.lift<{
    state: {
        wishes: [{ id: string; status: string; }, { id: string; status: string; }];
    };
}, [string, string][]>(({ state }) => Object.entries(state.wishes[1]), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                wishes: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            id: {
                                type: "string"
                            },
                            status: {
                                type: "string"
                            }
                        },
                        required: ["id", "status"]
                    }
                }
            },
            required: ["wishes"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "array",
        items: {
            type: "string"
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfLift_4, {
    sourceFile: "/test.tsx",
    position: { line: 17, col: 11 }
});
// FIXTURE: non-jsx-wildcard-traversal-call-roots
// Verifies: wildcard traversal calls lower as whole call roots outside JSX
export default __cfBindVerifiedBinding(pattern((state) => ({
    serialized: __cfLift_1({ state: {
            wishes: state.key("wishes")
        } }).for(["__patternResult", "serialized"], true),
    keys: __cfLift_2({ state: {
            wishes: state.key("wishes")
        } }).for(["__patternResult", "keys"], true),
    values: __cfLift_3({ state: {
            wishes: state.key("wishes")
        } }).for(["__patternResult", "values"], true),
    entries: __cfLift_4({ state: {
            wishes: state.key("wishes")
        } }).for(["__patternResult", "entries"], true)
}), {
    type: "object",
    properties: {
        wishes: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: {
                        type: "string"
                    },
                    status: {
                        type: "string"
                    }
                },
                required: ["id", "status"]
            }
        }
    },
    required: ["wishes"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        serialized: {
            type: "string"
        },
        keys: {
            type: "array",
            items: {
                type: "string"
            }
        },
        values: {
            type: "array",
            items: {
                type: "string"
            }
        },
        entries: {
            type: "array",
            items: {
                type: "array",
                items: {
                    type: "string"
                }
            }
        }
    },
    required: ["serialized", "keys", "values", "entries"]
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 13, col: 30 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2,
    __cfLift_3,
    __cfLift_4
});
