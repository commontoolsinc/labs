import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
interface Item {
    id: number;
    name: string;
}
interface User {
    firstName: string;
    lastName: string;
}
interface State {
    items: Item[];
    currentUser: User;
}
export default pattern((state) => {
    return {
        [UI]: (<div>
        {state.key("items").mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const item = __ct_pattern_input.key("element");
                const state = __ct_pattern_input.key("params", "state");
                return (<div>
            {item.key("name")} - edited by {__ctHelpers.derive({
                    type: "object",
                    properties: {
                        state: {
                            type: "object",
                            properties: {
                                currentUser: {
                                    type: "object",
                                    properties: {
                                        firstName: {
                                            type: "string"
                                        }
                                    },
                                    required: ["firstName"]
                                }
                            },
                            required: ["currentUser"]
                        }
                    },
                    required: ["state"]
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __ctHelpers.JSONSchema, { state: {
                        currentUser: {
                            firstName: state.key("currentUser").firstName
                        }
                    } }, ({ state }) => state.currentUser.firstName)} {__ctHelpers.derive({
                    type: "object",
                    properties: {
                        state: {
                            type: "object",
                            properties: {
                                currentUser: {
                                    type: "object",
                                    properties: {
                                        lastName: {
                                            type: "string"
                                        }
                                    },
                                    required: ["lastName"]
                                }
                            },
                            required: ["currentUser"]
                        }
                    },
                    required: ["state"]
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __ctHelpers.JSONSchema, { state: {
                        currentUser: {
                            lastName: state.key("currentUser").lastName
                        }
                    } }, ({ state }) => state.currentUser.lastName)}
          </div>);
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Item"
                    },
                    params: {
                        type: "object",
                        properties: {
                            state: {
                                type: "object",
                                properties: {
                                    currentUser: {
                                        type: "object",
                                        properties: {
                                            firstName: {
                                                type: "string"
                                            },
                                            lastName: {
                                                type: "string"
                                            }
                                        },
                                        required: ["firstName", "lastName"]
                                    }
                                },
                                required: ["currentUser"]
                            }
                        },
                        required: ["state"]
                    }
                },
                required: ["element", "params"],
                $defs: {
                    Item: {
                        type: "object",
                        properties: {
                            id: {
                                type: "number"
                            },
                            name: {
                                type: "string"
                            }
                        },
                        required: ["id", "name"]
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, {
                anyOf: [{
                        $ref: "https://commonfabric.org/schemas/vnode.json"
                    }, {
                        $ref: "#/$defs/UIRenderable"
                    }, {
                        type: "object",
                        properties: {}
                    }],
                $defs: {
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
            } as const satisfies __ctHelpers.JSONSchema), {
                state: {
                    currentUser: {
                        firstName: state.key("currentUser").firstName,
                        lastName: state.key("currentUser").lastName
                    }
                }
            })}
      </div>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        },
        currentUser: {
            $ref: "#/$defs/User"
        }
    },
    required: ["items", "currentUser"],
    $defs: {
        User: {
            type: "object",
            properties: {
                firstName: {
                    type: "string"
                },
                lastName: {
                    type: "string"
                }
            },
            required: ["firstName", "lastName"]
        },
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                name: {
                    type: "string"
                }
            },
            required: ["id", "name"]
        }
    }
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
