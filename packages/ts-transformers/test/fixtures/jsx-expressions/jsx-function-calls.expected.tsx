import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
const __lift_0 = __ctHelpers.lift({
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                values: {
                    type: "array",
                    items: {
                        type: "number"
                    },
                    asOpaque: true
                }
            },
            required: ["values"]
        }
    },
    required: ["state"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema, ({ state }) => state.values.reduce((a, b) => a + b, 0));
interface State {
    a: number;
    b: number;
    price: number;
    text: string;
    values: number[];
    name: string;
    float: string;
}
export default recipe({
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
        <h3>Math Functions</h3>
        <p>Max: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        a: {
                            type: "number",
                            asOpaque: true
                        },
                        b: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["a", "b"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                a: state.a,
                b: state.b
            } }, ({ state }) => Math.max(state.a, state.b))}</p>
        <p>Min: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        a: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["a"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                a: state.a
            } }, ({ state }) => Math.min(state.a, 10))}</p>
        <p>Abs: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        a: {
                            type: "number",
                            asOpaque: true
                        },
                        b: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["a", "b"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                a: state.a,
                b: state.b
            } }, ({ state }) => Math.abs(state.a - state.b))}</p>
        <p>Round: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        price: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["price"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                price: state.price
            } }, ({ state }) => Math.round(state.price))}</p>
        <p>Floor: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        price: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["price"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                price: state.price
            } }, ({ state }) => Math.floor(state.price))}</p>
        <p>Ceiling: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        price: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["price"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                price: state.price
            } }, ({ state }) => Math.ceil(state.price))}</p>
        <p>Square root: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        a: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["a"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                a: state.a
            } }, ({ state }) => Math.sqrt(state.a))}</p>

        <h3>String Methods as Function Calls</h3>
        <p>Uppercase: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string",
                            asOpaque: true
                        }
                    },
                    required: ["name"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                name: state.name
            } }, ({ state }) => state.name.toUpperCase())}</p>
        <p>Lowercase: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string",
                            asOpaque: true
                        }
                    },
                    required: ["name"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                name: state.name
            } }, ({ state }) => state.name.toLowerCase())}</p>
        <p>Substring: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        text: {
                            type: "string",
                            asOpaque: true
                        }
                    },
                    required: ["text"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                text: state.text
            } }, ({ state }) => state.text.substring(0, 5))}</p>
        <p>Replace: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        text: {
                            type: "string",
                            asOpaque: true
                        }
                    },
                    required: ["text"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                text: state.text
            } }, ({ state }) => state.text.replace("old", "new"))}</p>
        <p>Includes: {__ctHelpers.ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["Yes", "No"]
        } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        text: {
                            type: "string",
                            asOpaque: true
                        }
                    },
                    required: ["text"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                text: state.text
            } }, ({ state }) => state.text.includes("test")), "Yes", "No")}</p>
        <p>Starts with: {__ctHelpers.ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["Yes", "No"]
        } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string",
                            asOpaque: true
                        }
                    },
                    required: ["name"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                name: state.name
            } }, ({ state }) => state.name.startsWith("A")), "Yes", "No")}</p>

        <h3>Number Methods</h3>
        <p>To Fixed: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        price: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["price"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                price: state.price
            } }, ({ state }) => state.price.toFixed(2))}</p>
        <p>To Precision: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        price: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["price"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                price: state.price
            } }, ({ state }) => state.price.toPrecision(4))}</p>

        <h3>Parse Functions</h3>
        <p>Parse Int: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        float: {
                            type: "string",
                            asOpaque: true
                        }
                    },
                    required: ["float"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                float: state.float
            } }, ({ state }) => parseInt(state.float))}</p>
        <p>Parse Float: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        float: {
                            type: "string",
                            asOpaque: true
                        }
                    },
                    required: ["float"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                float: state.float
            } }, ({ state }) => parseFloat(state.float))}</p>

        <h3>Array Method Calls</h3>
        <p>Sum: {__lift_0({ state: {
                values: state.values
            } })}</p>
        <p>Max value: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        values: {
                            type: "array",
                            items: {
                                type: "number"
                            },
                            asOpaque: true
                        }
                    },
                    required: ["values"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                values: state.values
            } }, ({ state }) => Math.max(...state.values))}</p>
        <p>Joined: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        values: {
                            type: "array",
                            items: {
                                type: "number"
                            },
                            asOpaque: true
                        }
                    },
                    required: ["values"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                values: state.values
            } }, ({ state }) => state.values.join(", "))}</p>

        <h3>Complex Function Calls</h3>
        <p>Multiple args: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        a: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["a"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                a: state.a
            } }, ({ state }) => Math.pow(state.a, 2))}</p>
        <p>Nested calls: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        a: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["a"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                a: state.a
            } }, ({ state }) => Math.round(Math.sqrt(state.a)))}</p>
        <p>Chained calls: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string",
                            asOpaque: true
                        }
                    },
                    required: ["name"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                name: state.name
            } }, ({ state }) => state.name.trim().toUpperCase())}</p>
        <p>With expressions: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        a: {
                            type: "number",
                            asOpaque: true
                        },
                        b: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["a", "b"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                a: state.a,
                b: state.b
            } }, ({ state }) => Math.max(state.a + 1, state.b * 2))}</p>
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
