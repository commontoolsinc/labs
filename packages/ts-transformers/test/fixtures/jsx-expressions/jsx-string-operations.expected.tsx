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
                    $ref: "https://commonfabric.org/schemas/vnode.json"
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
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }
            },
            required: ["$UI"]
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
