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
// FIXTURE: non-jsx-wildcard-traversal-call-roots
// Verifies: wildcard traversal calls lower as whole call roots outside JSX
export default pattern((state) => ({
    serialized: __cfHelpers.derive({
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
    } as const satisfies __cfHelpers.JSONSchema, { state: {
            wishes: state.key("wishes")
        } }, ({ state }) => JSON.stringify(state.wishes[1])),
    keys: __cfHelpers.derive({
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
    } as const satisfies __cfHelpers.JSONSchema, { state: {
            wishes: state.key("wishes")
        } }, ({ state }) => Object.keys(state.wishes[1])),
    values: __cfHelpers.derive({
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
    } as const satisfies __cfHelpers.JSONSchema, { state: {
            wishes: state.key("wishes")
        } }, ({ state }) => Object.values(state.wishes[1])),
    entries: __cfHelpers.derive({
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
    } as const satisfies __cfHelpers.JSONSchema, { state: {
            wishes: state.key("wishes")
        } }, ({ state }) => Object.entries(state.wishes[1])),
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
