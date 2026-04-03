import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
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
      <p>{__ctHelpers.derive({
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
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema, { state: {
            wishes: state.key("wishes")
        } }, ({ state }) => JSON.stringify(state.wishes[1]))}</p>
      <p>{__ctHelpers.derive({
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
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __ctHelpers.JSONSchema, { state: {
            wishes: state.key("wishes")
        } }, ({ state }) => Object.keys(state.wishes[1]))}</p>
      <p>{__ctHelpers.derive({
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
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __ctHelpers.JSONSchema, { state: {
            wishes: state.key("wishes")
        } }, ({ state }) => Object.values(state.wishes[1]))}</p>
      <p>{__ctHelpers.derive({
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
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "array",
            items: {
                type: "string"
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, { state: {
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
} as const satisfies __ctHelpers.JSONSchema, {
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
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
