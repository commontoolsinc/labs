function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, UI } from "commonfabric";
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
// FIXTURE: jsx-wildcard-traversal-call-roots
// Verifies: wildcard traversal calls lower as whole JSX call roots
export default pattern((state) => ({
    [UI]: (<div>
      <p>{__cfHelpers.derive({
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
        } }, ({ state }) => JSON.stringify(state.wishes[1]))}</p>
      <p>{__cfHelpers.derive({
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
        } }, ({ state }) => Object.keys(state.wishes[1]))}</p>
      <p>{__cfHelpers.derive({
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
        } }, ({ state }) => Object.values(state.wishes[1]))}</p>
      <p>{__cfHelpers.derive({
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
        } }, ({ state }) => Object.entries(state.wishes[1]))}</p>
    </div>),
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
