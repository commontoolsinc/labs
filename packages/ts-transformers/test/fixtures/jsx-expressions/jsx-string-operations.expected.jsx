function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
interface State {
    firstName: string;
    lastName: string;
    title: string;
    message: string;
    count: number;
}
// FIXTURE: jsx-string-operations
// Verifies: string concatenation, template literals, and string methods in JSX are wrapped in derive()
//   state.title + ": " + state.firstName → derive({title, firstName}, ...)
//   `Welcome, ${state.firstName}!`       → derive({firstName}, ...)
//   state.firstName.toUpperCase()        → derive({firstName}, ...)
export default pattern((state) => {
    return {
        [UI]: (<div>
        <h3>String Concatenation</h3>
        <h1>{__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        title: {
                            type: "string"
                        },
                        firstName: {
                            type: "string"
                        },
                        lastName: {
                            type: "string"
                        }
                    },
                    required: ["title", "firstName", "lastName"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                title: state.key("title"),
                firstName: state.key("firstName"),
                lastName: state.key("lastName")
            } }, ({ state }) => state.title + ": " + state.firstName + " " + state.lastName)}</h1>
        <p>{__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
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
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                firstName: state.key("firstName"),
                lastName: state.key("lastName")
            } }, ({ state }) => state.firstName + state.lastName)}</p>
        <p>{__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        firstName: {
                            type: "string"
                        }
                    },
                    required: ["firstName"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                firstName: state.key("firstName")
            } }, ({ state }) => "Hello, " + state.firstName + "!")}</p>

        <h3>Template Literals</h3>
        <p>{__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        firstName: {
                            type: "string"
                        }
                    },
                    required: ["firstName"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                firstName: state.key("firstName")
            } }, ({ state }) => `Welcome, ${state.firstName}!`)}</p>
        <p>{__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
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
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                firstName: state.key("firstName"),
                lastName: state.key("lastName")
            } }, ({ state }) => `Full name: ${state.firstName} ${state.lastName}`)}</p>
        <p>{__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        title: {
                            type: "string"
                        },
                        firstName: {
                            type: "string"
                        },
                        lastName: {
                            type: "string"
                        }
                    },
                    required: ["title", "firstName", "lastName"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                title: state.key("title"),
                firstName: state.key("firstName"),
                lastName: state.key("lastName")
            } }, ({ state }) => `${state.title}: ${state.firstName} ${state.lastName}`)}</p>

        <h3>String Methods</h3>
        <p>Uppercase: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        firstName: {
                            type: "string"
                        }
                    },
                    required: ["firstName"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                firstName: state.key("firstName")
            } }, ({ state }) => state.firstName.toUpperCase())}</p>
        <p>Lowercase: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        title: {
                            type: "string"
                        }
                    },
                    required: ["title"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                title: state.key("title")
            } }, ({ state }) => state.title.toLowerCase())}</p>
        <p>Length: {state.key("message", "length")}</p>
        <p>Substring: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        message: {
                            type: "string"
                        }
                    },
                    required: ["message"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                message: state.key("message")
            } }, ({ state }) => state.message.substring(0, 5))}</p>

        <h3>Mixed String and Number</h3>
        <p>{__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        firstName: {
                            type: "string"
                        },
                        count: {
                            type: "number"
                        }
                    },
                    required: ["firstName", "count"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                firstName: state.key("firstName"),
                count: state.key("count")
            } }, ({ state }) => state.firstName + " has " + state.count + " items")}</p>
        <p>{__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        firstName: {
                            type: "string"
                        },
                        count: {
                            type: "number"
                        }
                    },
                    required: ["firstName", "count"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                firstName: state.key("firstName"),
                count: state.key("count")
            } }, ({ state }) => `${state.firstName} has ${state.count} items`)}</p>
        <p>Count as string: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        count: {
                            type: "number"
                        }
                    },
                    required: ["count"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                count: state.key("count")
            } }, ({ state }) => "Count: " + state.count)}</p>
      </div>),
    };
}, {
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
__ctHardenFn(h);
