import * as __cfHelpers from "commonfabric";
import { pattern, UI } from "commonfabric";
interface State {
    a: number;
    b: number;
    price: number;
    text: string;
    values: number[];
    name: string;
    float: string;
}
// FIXTURE: jsx-function-calls
// Verifies: function/method calls with reactive args in JSX are wrapped in derive()
//   Math.max(state.a, state.b)     → derive({a, b}, ({state}) => Math.max(state.a, state.b))
//   state.name.toUpperCase()       → derive({name}, ...)
//   parseInt(state.float)          → derive({float}, ...)
export default pattern((state) => {
    return {
        [UI]: (<div>
        <h3>Math Functions</h3>
        <p>Max: {__cfHelpers.derive({
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
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                a: state.key("a"),
                b: state.key("b")
            } }, ({ state }) => Math.max(state.a, state.b))}</p>
        <p>Min: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        a: {
                            type: "number"
                        }
                    },
                    required: ["a"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                a: state.key("a")
            } }, ({ state }) => Math.min(state.a, 10))}</p>
        <p>Abs: {__cfHelpers.derive({
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
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                a: state.key("a"),
                b: state.key("b")
            } }, ({ state }) => Math.abs(state.a - state.b))}</p>
        <p>Round: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        price: {
                            type: "number"
                        }
                    },
                    required: ["price"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                price: state.key("price")
            } }, ({ state }) => Math.round(state.price))}</p>
        <p>Floor: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        price: {
                            type: "number"
                        }
                    },
                    required: ["price"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                price: state.key("price")
            } }, ({ state }) => Math.floor(state.price))}</p>
        <p>Ceiling: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        price: {
                            type: "number"
                        }
                    },
                    required: ["price"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                price: state.key("price")
            } }, ({ state }) => Math.ceil(state.price))}</p>
        <p>Square root: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        a: {
                            type: "number"
                        }
                    },
                    required: ["a"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                a: state.key("a")
            } }, ({ state }) => Math.sqrt(state.a))}</p>

        <h3>String Methods as Function Calls</h3>
        <p>Uppercase: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        }
                    },
                    required: ["name"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                name: state.key("name")
            } }, ({ state }) => state.name.toUpperCase())}</p>
        <p>Lowercase: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        }
                    },
                    required: ["name"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                name: state.key("name")
            } }, ({ state }) => state.name.toLowerCase())}</p>
        <p>Substring: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        text: {
                            type: "string"
                        }
                    },
                    required: ["text"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                text: state.key("text")
            } }, ({ state }) => state.text.substring(0, 5))}</p>
        <p>Replace: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        text: {
                            type: "string"
                        }
                    },
                    required: ["text"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                text: state.key("text")
            } }, ({ state }) => state.text.replace("old", "new"))}</p>
        <p>Includes: {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Yes", "No"]
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        text: {
                            type: "string"
                        }
                    },
                    required: ["text"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                text: state.key("text")
            } }, ({ state }) => state.text.includes("test")), "Yes", "No")}</p>
        <p>Starts with: {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Yes", "No"]
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        }
                    },
                    required: ["name"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                name: state.key("name")
            } }, ({ state }) => state.name.startsWith("A")), "Yes", "No")}</p>

        <h3>Number Methods</h3>
        <p>To Fixed: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        price: {
                            type: "number"
                        }
                    },
                    required: ["price"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                price: state.key("price")
            } }, ({ state }) => state.price.toFixed(2))}</p>
        <p>To Precision: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        price: {
                            type: "number"
                        }
                    },
                    required: ["price"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                price: state.key("price")
            } }, ({ state }) => state.price.toPrecision(4))}</p>

        <h3>Parse Functions</h3>
        <p>Parse Int: {__cfHelpers.derive({
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
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                float: state.key("float")
            } }, ({ state }) => parseInt(state.float))}</p>
        <p>Parse Float: {__cfHelpers.derive({
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
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                float: state.key("float")
            } }, ({ state }) => parseFloat(state.float))}</p>

        <h3>Array Method Calls</h3>
        <p>Sum: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        values: {
                            type: "array",
                            items: {
                                type: "number"
                            }
                        }
                    },
                    required: ["values"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                values: state.key("values")
            } }, ({ state }) => state.values.reduce((a, b) => a + b, 0))}</p>
        <p>Max value: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        values: {
                            type: "array",
                            items: {
                                type: "number"
                            }
                        }
                    },
                    required: ["values"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                values: state.key("values")
            } }, ({ state }) => Math.max(...state.values))}</p>
        <p>Joined: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        values: {
                            type: "array",
                            items: {
                                type: "number"
                            }
                        }
                    },
                    required: ["values"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                values: state.key("values")
            } }, ({ state }) => state.values.join(", "))}</p>

        <h3>Complex Function Calls</h3>
        <p>Multiple args: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        a: {
                            type: "number"
                        }
                    },
                    required: ["a"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                a: state.key("a")
            } }, ({ state }) => Math.pow(state.a, 2))}</p>
        <p>Nested calls: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        a: {
                            type: "number"
                        }
                    },
                    required: ["a"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                a: state.key("a")
            } }, ({ state }) => Math.round(Math.sqrt(state.a)))}</p>
        <p>Chained calls: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        }
                    },
                    required: ["name"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                name: state.key("name")
            } }, ({ state }) => state.name.trim().toUpperCase())}</p>
        <p>With expressions: {__cfHelpers.derive({
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
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                a: state.key("a"),
                b: state.key("b")
            } }, ({ state }) => Math.max(state.a + 1, state.b * 2))}</p>
      </div>),
    };
}, {
    type: "object",
    properties: {
        a: {
            type: "number"
        },
        b: {
            type: "number"
        },
        price: {
            type: "number"
        },
        text: {
            type: "string"
        },
        values: {
            type: "array",
            items: {
                type: "number"
            }
        },
        name: {
            type: "string"
        },
        float: {
            type: "string"
        }
    },
    required: ["a", "b", "price", "text", "values", "name", "float"]
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
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
