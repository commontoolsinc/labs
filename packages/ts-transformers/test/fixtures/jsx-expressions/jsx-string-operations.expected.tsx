import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
interface State {
    firstName: string;
    lastName: string;
    title: string;
    message: string;
    count: number;
}
export default recipe({
    type: "object",
    properties: {
        firstName: {
            type: "string"
        },
        lastName: {
            type: "string"
        },
        title: {
            type: "string"
        },
        message: {
            type: "string"
        },
        count: {
            type: "number"
        }
    },
    required: ["firstName", "lastName", "title", "message", "count"]
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
                    $ref: "#/$defs/VNode"
                }, {
                    $ref: "#/$defs/VNodeResult"
                }, {
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable",
                    asOpaque: true
                }]
        },
        UIRenderable: {
            type: "object",
            properties: {
                $UI: {
                    $ref: "#/$defs/VNode"
                }
            },
            required: ["$UI"]
        },
        VNodeResult: {
            type: "object",
            properties: {
                type: {
                    type: "string",
                    "enum": ["vnode"]
                },
                name: {
                    type: "string"
                },
                props: {
                    $ref: "#/$defs/PropsResult"
                },
                children: {
                    type: "array",
                    items: {
                        anyOf: [{
                                type: "string"
                            }, {
                                type: "number"
                            }, {
                                type: "boolean",
                                "enum": [false]
                            }, {
                                type: "boolean",
                                "enum": [true]
                            }, {
                                $ref: "#/$defs/VNodeResult"
                            }, {
                                type: "null"
                            }]
                    }
                },
                $UI: {
                    $ref: "#/$defs/VNodeResult"
                }
            },
            required: ["type", "name", "props"]
        },
        PropsResult: {
            type: "object",
            properties: {},
            additionalProperties: {
                anyOf: [{
                        type: "string"
                    }, {
                        type: "number"
                    }, {
                        type: "boolean",
                        "enum": [false]
                    }, {
                        type: "boolean",
                        "enum": [true]
                    }, {
                        type: "object",
                        additionalProperties: true
                    }, {
                        type: "array",
                        items: true
                    }, {
                        asStream: true
                    }, {
                        type: "null"
                    }]
            }
        },
        VNode: {
            type: "object",
            properties: {
                type: {
                    type: "string",
                    "enum": ["vnode"]
                },
                name: {
                    type: "string"
                },
                props: {
                    $ref: "#/$defs/Props"
                },
                children: {
                    $ref: "#/$defs/RenderNode"
                },
                $UI: {
                    $ref: "#/$defs/VNode"
                }
            },
            required: ["type", "name", "props"]
        },
        RenderNode: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "number"
                }, {
                    type: "boolean",
                    "enum": [false]
                }, {
                    type: "boolean",
                    "enum": [true]
                }, {
                    $ref: "#/$defs/VNode"
                }, {
                    $ref: "#/$defs/VNodeResult"
                }, {
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable",
                    asOpaque: true
                }, {
                    type: "object",
                    properties: {}
                }, {
                    type: "array",
                    items: {
                        $ref: "#/$defs/RenderNode"
                    }
                }, {
                    type: "null"
                }]
        },
        Props: {
            type: "object",
            properties: {},
            additionalProperties: {
                anyOf: [{
                        type: "string"
                    }, {
                        type: "number"
                    }, {
                        type: "boolean",
                        "enum": [false]
                    }, {
                        type: "boolean",
                        "enum": [true]
                    }, {
                        type: "object",
                        additionalProperties: true
                    }, {
                        type: "array",
                        items: true
                    }, {
                        asCell: true
                    }, {
                        asStream: true
                    }, {
                        type: "null"
                    }]
            }
        }
    }
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        <h3>String Concatenation</h3>
        <h1>{__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        title: {
                            type: "string",
                            asOpaque: true
                        },
                        firstName: {
                            type: "string",
                            asOpaque: true
                        },
                        lastName: {
                            type: "string",
                            asOpaque: true
                        }
                    },
                    required: ["title", "firstName", "lastName"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                title: state.title,
                firstName: state.firstName,
                lastName: state.lastName
            } }, ({ state }) => state.title + ": " + state.firstName + " " + state.lastName)}</h1>
        <p>{__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        firstName: {
                            type: "string",
                            asOpaque: true
                        },
                        lastName: {
                            type: "string",
                            asOpaque: true
                        }
                    },
                    required: ["firstName", "lastName"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                firstName: state.firstName,
                lastName: state.lastName
            } }, ({ state }) => state.firstName + state.lastName)}</p>
        <p>{__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        firstName: {
                            type: "string",
                            asOpaque: true
                        }
                    },
                    required: ["firstName"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                firstName: state.firstName
            } }, ({ state }) => "Hello, " + state.firstName + "!")}</p>

        <h3>Template Literals</h3>
        <p>{__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        firstName: {
                            type: "string",
                            asOpaque: true
                        }
                    },
                    required: ["firstName"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                firstName: state.firstName
            } }, ({ state }) => `Welcome, ${state.firstName}!`)}</p>
        <p>{__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        firstName: {
                            type: "string",
                            asOpaque: true
                        },
                        lastName: {
                            type: "string",
                            asOpaque: true
                        }
                    },
                    required: ["firstName", "lastName"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                firstName: state.firstName,
                lastName: state.lastName
            } }, ({ state }) => `Full name: ${state.firstName} ${state.lastName}`)}</p>
        <p>{__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        title: {
                            type: "string",
                            asOpaque: true
                        },
                        firstName: {
                            type: "string",
                            asOpaque: true
                        },
                        lastName: {
                            type: "string",
                            asOpaque: true
                        }
                    },
                    required: ["title", "firstName", "lastName"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                title: state.title,
                firstName: state.firstName,
                lastName: state.lastName
            } }, ({ state }) => `${state.title}: ${state.firstName} ${state.lastName}`)}</p>

        <h3>String Methods</h3>
        <p>Uppercase: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        firstName: {
                            type: "string",
                            asOpaque: true
                        }
                    },
                    required: ["firstName"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                firstName: state.firstName
            } }, ({ state }) => state.firstName.toUpperCase())}</p>
        <p>Lowercase: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        title: {
                            type: "string",
                            asOpaque: true
                        }
                    },
                    required: ["title"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                title: state.title
            } }, ({ state }) => state.title.toLowerCase())}</p>
        <p>Length: {state.message.length}</p>
        <p>Substring: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        message: {
                            type: "string",
                            asOpaque: true
                        }
                    },
                    required: ["message"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                message: state.message
            } }, ({ state }) => state.message.substring(0, 5))}</p>

        <h3>Mixed String and Number</h3>
        <p>{__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        firstName: {
                            type: "string",
                            asOpaque: true
                        },
                        count: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["firstName", "count"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                firstName: state.firstName,
                count: state.count
            } }, ({ state }) => state.firstName + " has " + state.count + " items")}</p>
        <p>{__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        firstName: {
                            type: "string",
                            asOpaque: true
                        },
                        count: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["firstName", "count"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                firstName: state.firstName,
                count: state.count
            } }, ({ state }) => `${state.firstName} has ${state.count} items`)}</p>
        <p>Count as string: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        count: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["count"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                count: state.count
            } }, ({ state }) => "Count: " + state.count)}</p>
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
