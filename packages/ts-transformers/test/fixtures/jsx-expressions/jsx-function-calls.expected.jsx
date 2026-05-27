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
        <p>Max: {__cfHelpers.lift<{
            state: {
                a: number;
                b: number;
            };
        }, number>({
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
        } as const satisfies __cfHelpers.JSONSchema, ({ state }) => Math.max(state.a, state.b))({ state: {
                a: state.key("a"),
                b: state.key("b")
            } })}</p>
        <p>Min: {__cfHelpers.lift<{
            state: {
                a: number;
            };
        }, number>({
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
        } as const satisfies __cfHelpers.JSONSchema, ({ state }) => Math.min(state.a, 10))({ state: {
                a: state.key("a")
            } })}</p>
        <p>Abs: {__cfHelpers.lift<{
            state: {
                a: number;
                b: number;
            };
        }, number>({
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
        } as const satisfies __cfHelpers.JSONSchema, ({ state }) => Math.abs(state.a - state.b))({ state: {
                a: state.key("a"),
                b: state.key("b")
            } })}</p>
        <p>Round: {__cfHelpers.lift<{
            state: {
                price: number;
            };
        }, number>({
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
        } as const satisfies __cfHelpers.JSONSchema, ({ state }) => Math.round(state.price))({ state: {
                price: state.key("price")
            } })}</p>
        <p>Floor: {__cfHelpers.lift<{
            state: {
                price: number;
            };
        }, number>({
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
        } as const satisfies __cfHelpers.JSONSchema, ({ state }) => Math.floor(state.price))({ state: {
                price: state.key("price")
            } })}</p>
        <p>Ceiling: {__cfHelpers.lift<{
            state: {
                price: number;
            };
        }, number>({
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
        } as const satisfies __cfHelpers.JSONSchema, ({ state }) => Math.ceil(state.price))({ state: {
                price: state.key("price")
            } })}</p>
        <p>Square root: {__cfHelpers.lift<{
            state: {
                a: number;
            };
        }, number>({
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
        } as const satisfies __cfHelpers.JSONSchema, ({ state }) => Math.sqrt(state.a))({ state: {
                a: state.key("a")
            } })}</p>

        <h3>String Methods as Function Calls</h3>
        <p>Uppercase: {__cfHelpers.lift<{
            state: {
                name: string;
            };
        }, string>({
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
        } as const satisfies __cfHelpers.JSONSchema, ({ state }) => state.name.toUpperCase())({ state: {
                name: state.key("name")
            } })}</p>
        <p>Lowercase: {__cfHelpers.lift<{
            state: {
                name: string;
            };
        }, string>({
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
        } as const satisfies __cfHelpers.JSONSchema, ({ state }) => state.name.toLowerCase())({ state: {
                name: state.key("name")
            } })}</p>
        <p>Substring: {__cfHelpers.lift<{
            state: {
                text: string;
            };
        }, string>({
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
        } as const satisfies __cfHelpers.JSONSchema, ({ state }) => state.text.substring(0, 5))({ state: {
                text: state.key("text")
            } })}</p>
        <p>Replace: {__cfHelpers.lift<{
            state: {
                text: string;
            };
        }, string>({
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
        } as const satisfies __cfHelpers.JSONSchema, ({ state }) => state.text.replace("old", "new"))({ state: {
                text: state.key("text")
            } })}</p>
        <p>Includes: {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Yes", "No"]
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.lift<{
            state: {
                text: string;
            };
        }, boolean>({
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
        } as const satisfies __cfHelpers.JSONSchema, ({ state }) => state.text.includes("test"))({ state: {
                text: state.key("text")
            } }), "Yes", "No")}</p>
        <p>Starts with: {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["Yes", "No"]
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.lift<{
            state: {
                name: string;
            };
        }, boolean>({
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
        } as const satisfies __cfHelpers.JSONSchema, ({ state }) => state.name.startsWith("A"))({ state: {
                name: state.key("name")
            } }), "Yes", "No")}</p>

        <h3>Number Methods</h3>
        <p>To Fixed: {__cfHelpers.lift<{
            state: {
                price: number;
            };
        }, string>({
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
        } as const satisfies __cfHelpers.JSONSchema, ({ state }) => state.price.toFixed(2))({ state: {
                price: state.key("price")
            } })}</p>
        <p>To Precision: {__cfHelpers.lift<{
            state: {
                price: number;
            };
        }, string>({
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
        } as const satisfies __cfHelpers.JSONSchema, ({ state }) => state.price.toPrecision(4))({ state: {
                price: state.key("price")
            } })}</p>

        <h3>Parse Functions</h3>
        <p>Parse Int: {__cfHelpers.lift<{
            state: {
                float: string;
            };
        }, number>({
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
        } as const satisfies __cfHelpers.JSONSchema, ({ state }) => parseInt(state.float))({ state: {
                float: state.key("float")
            } })}</p>
        <p>Parse Float: {__cfHelpers.lift<{
            state: {
                float: string;
            };
        }, number>({
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
        } as const satisfies __cfHelpers.JSONSchema, ({ state }) => parseFloat(state.float))({ state: {
                float: state.key("float")
            } })}</p>

        <h3>Array Method Calls</h3>
        <p>Sum: {__cfHelpers.lift<{
            state: {
                values: number[];
            };
        }, number>({
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
        } as const satisfies __cfHelpers.JSONSchema, ({ state }) => state.values.reduce((a, b) => a + b, 0))({ state: {
                values: state.key("values")
            } })}</p>
        <p>Max value: {__cfHelpers.lift<{
            state: {
                values: number[];
            };
        }, number>({
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
        } as const satisfies __cfHelpers.JSONSchema, ({ state }) => Math.max(...state.values))({ state: {
                values: state.key("values")
            } })}</p>
        <p>Joined: {__cfHelpers.lift<{
            state: {
                values: number[];
            };
        }, string>({
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
        } as const satisfies __cfHelpers.JSONSchema, ({ state }) => state.values.join(", "))({ state: {
                values: state.key("values")
            } })}</p>

        <h3>Complex Function Calls</h3>
        <p>Multiple args: {__cfHelpers.lift<{
            state: {
                a: number;
            };
        }, number>({
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
        } as const satisfies __cfHelpers.JSONSchema, ({ state }) => Math.pow(state.a, 2))({ state: {
                a: state.key("a")
            } })}</p>
        <p>Nested calls: {__cfHelpers.lift<{
            state: {
                a: number;
            };
        }, number>({
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
        } as const satisfies __cfHelpers.JSONSchema, ({ state }) => Math.round(Math.sqrt(state.a)))({ state: {
                a: state.key("a")
            } })}</p>
        <p>Chained calls: {__cfHelpers.lift<{
            state: {
                name: string;
            };
        }, string>({
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
        } as const satisfies __cfHelpers.JSONSchema, ({ state }) => state.name.trim().toUpperCase())({ state: {
                name: state.key("name")
            } })}</p>
        <p>With expressions: {__cfHelpers.lift<{
            state: {
                a: number;
                b: number;
            };
        }, number>({
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
        } as const satisfies __cfHelpers.JSONSchema, ({ state }) => Math.max(state.a + 1, state.b * 2))({ state: {
                a: state.key("a"),
                b: state.key("b")
            } })}</p>
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
__cfHardenFn(h);
