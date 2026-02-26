import * as __ctHelpers from "commontools";
import { ifElse, pattern, UI } from "commontools";
interface State {
    matrix: number[][];
    row: number;
    col: number;
    items: string[];
    arr: number[];
    a: number;
    b: number;
    indices: number[];
    nested: {
        arrays: string[][];
        index: number;
    };
    users: Array<{
        name: string;
        scores: number[];
    }>;
    selectedUser: number;
    selectedScore: number;
}
export default pattern((state) => {
    return {
        [UI]: (<div>
        <h3>Nested Element Access</h3>
        {/* Double indexing into matrix */}
        <p>Matrix value: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        matrix: {
                            type: "array",
                            items: {
                                type: "array",
                                items: {
                                    type: "number"
                                }
                            },
                            asOpaque: true
                        },
                        row: {
                            type: "number",
                            asOpaque: true
                        },
                        col: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["matrix", "row", "col"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    type: "undefined"
                }, {
                    type: "number",
                    asOpaque: true
                }]
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                matrix: state.matrix,
                row: state.row,
                col: state.col
            } }, ({ state }) => state.matrix[state.row]![state.col])}</p>

        {/* Triple nested access */}
        <p>Deep nested: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        nested: {
                            type: "object",
                            properties: {
                                arrays: {
                                    type: "array",
                                    items: {
                                        type: "array",
                                        items: {
                                            type: "string"
                                        }
                                    },
                                    asOpaque: true
                                },
                                index: {
                                    type: "number",
                                    asOpaque: true
                                }
                            },
                            required: ["arrays", "index"]
                        },
                        row: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["nested", "row"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    type: "undefined"
                }, {
                    type: "string",
                    asOpaque: true
                }]
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                nested: {
                    arrays: state.nested.arrays,
                    index: state.nested.index
                },
                row: state.row
            } }, ({ state }) => state.nested.arrays[state.nested.index]![state.row])}</p>

        <h3>Multiple References to Same Array</h3>
        {/* Same array accessed multiple times with different indices */}
        <p>
          First and last: {state.items[0]} and{" "}
          {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        items: {
                            type: "array",
                            items: {
                                type: "string"
                            },
                            asOpaque: true
                        }
                    },
                    required: ["items"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    type: "undefined"
                }, {
                    type: "string",
                    asOpaque: true
                }]
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                items: state.items
            } }, ({ state }) => state.items[state.items.length - 1])}
        </p>

        {/* Array used in computation and access */}
        <p>Sum of ends: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        arr: {
                            type: "array",
                            items: {
                                type: "number"
                            },
                            asOpaque: true
                        }
                    },
                    required: ["arr"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                arr: state.arr
            } }, ({ state }) => state.arr[0]! + state.arr[state.arr.length - 1]!)}</p>

        <h3>Computed Indices</h3>
        {/* Index from multiple state values */}
        <p>Computed index: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        arr: {
                            type: "array",
                            items: {
                                type: "number"
                            },
                            asOpaque: true
                        },
                        a: {
                            type: "number",
                            asOpaque: true
                        },
                        b: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["arr", "a", "b"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    type: "undefined"
                }, {
                    type: "number",
                    asOpaque: true
                }]
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                arr: state.arr,
                a: state.a,
                b: state.b
            } }, ({ state }) => state.arr[state.a + state.b])}</p>

        {/* Index from computation involving array */}
        <p>Modulo index: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        items: {
                            type: "array",
                            items: {
                                type: "string"
                            },
                            asOpaque: true
                        },
                        row: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["items", "row"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    type: "undefined"
                }, {
                    type: "string",
                    asOpaque: true
                }]
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                items: state.items,
                row: state.row
            } }, ({ state }) => state.items[state.row % state.items.length])}</p>

        {/* Complex index expression */}
        <p>Complex: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        arr: {
                            type: "array",
                            items: {
                                type: "number"
                            },
                            asOpaque: true
                        },
                        a: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["arr", "a"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    type: "undefined"
                }, {
                    type: "number",
                    asOpaque: true
                }]
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                arr: state.arr,
                a: state.a
            } }, ({ state }) => state.arr[Math.min(state.a * 2, state.arr.length - 1)])}</p>

        <h3>Chained Element Access</h3>
        {/* Element access returning array, then accessing that */}
        <p>
          User score:{" "}
          {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        users: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    name: {
                                        type: "string"
                                    },
                                    scores: {
                                        type: "array",
                                        items: {
                                            type: "number"
                                        }
                                    }
                                },
                                required: ["name", "scores"]
                            },
                            asOpaque: true
                        },
                        selectedUser: {
                            type: "number",
                            asOpaque: true
                        },
                        selectedScore: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["users", "selectedUser", "selectedScore"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    type: "undefined"
                }, {
                    type: "number",
                    asOpaque: true
                }]
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                users: state.users,
                selectedUser: state.selectedUser,
                selectedScore: state.selectedScore
            } }, ({ state }) => state.users[state.selectedUser]!.scores[state.selectedScore])!}
        </p>

        {/* Using one array element as index for another */}
        <p>Indirect: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        items: {
                            type: "array",
                            items: {
                                type: "string"
                            },
                            asOpaque: true
                        },
                        indices: {
                            type: "array",
                            items: {
                                type: "number"
                            },
                            asOpaque: true
                        }
                    },
                    required: ["items", "indices"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    type: "undefined"
                }, {
                    type: "string",
                    asOpaque: true
                }]
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                items: state.items,
                indices: state.indices
            } }, ({ state }) => state.items[state.indices[0]!])}</p>

        {/* Array element used as index for same array */}
        <p>Self reference: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        arr: {
                            type: "array",
                            items: {
                                type: "number"
                            },
                            asOpaque: true
                        }
                    },
                    required: ["arr"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    type: "undefined"
                }, {
                    type: "number",
                    asOpaque: true
                }]
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                arr: state.arr
            } }, ({ state }) => state.arr[state.arr[0]!])}</p>

        <h3>Mixed Property and Element Access</h3>
        {/* Property access followed by element access with computed index */}
        <p>Mixed: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        nested: {
                            type: "object",
                            properties: {
                                arrays: {
                                    type: "array",
                                    items: {
                                        type: "array",
                                        items: {
                                            type: "string"
                                        }
                                    },
                                    asOpaque: true
                                },
                                index: {
                                    type: "number",
                                    asOpaque: true
                                }
                            },
                            required: ["arrays", "index"]
                        }
                    },
                    required: ["nested"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                nested: {
                    arrays: state.nested.arrays,
                    index: state.nested.index
                }
            } }, ({ state }) => state.nested.arrays[state.nested.index]!.length)}</p>

        {/* Element access followed by property access */}
        <p>User name length: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        users: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    name: {
                                        type: "string"
                                    },
                                    scores: {
                                        type: "array",
                                        items: {
                                            type: "number"
                                        }
                                    }
                                },
                                required: ["name", "scores"]
                            },
                            asOpaque: true
                        },
                        selectedUser: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["users", "selectedUser"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                users: state.users,
                selectedUser: state.selectedUser
            } }, ({ state }) => state.users[state.selectedUser]!.name.length)}</p>

        <h3>Element Access in Conditions</h3>
        {/* Element access in ternary */}
        <p>
          Conditional:{" "}
          {__ctHelpers.ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string",
            asOpaque: true
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string",
            asOpaque: true
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string",
            asOpaque: true
        } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        arr: {
                            type: "array",
                            items: {
                                type: "number"
                            },
                            asOpaque: true
                        },
                        a: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["arr", "a"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                arr: state.arr,
                a: state.a
            } }, ({ state }) => state.arr[state.a]! > 10), __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        items: {
                            type: "array",
                            items: {
                                type: "string"
                            },
                            asOpaque: true
                        },
                        b: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["items", "b"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string",
            asOpaque: true
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                items: state.items,
                b: state.b
            } }, ({ state }) => state.items[state.b]!), state.items[0]!)}
        </p>

        {/* Element access in boolean expression */}
        <p>
          Has value: {ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["positive", "non-positive"],
            asOpaque: true
        } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        matrix: {
                            type: "array",
                            items: {
                                type: "array",
                                items: {
                                    type: "number"
                                }
                            },
                            asOpaque: true
                        },
                        row: {
                            type: "number",
                            asOpaque: true
                        },
                        col: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["matrix", "row", "col"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                matrix: state.matrix,
                row: state.row,
                col: state.col
            } }, ({ state }) => state.matrix[state.row]![state.col]! > 0), "positive", "non-positive")}
        </p>

        <h3>Element Access with Operators</h3>
        {/* Element access with arithmetic */}
        <p>Product: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        arr: {
                            type: "array",
                            items: {
                                type: "number"
                            },
                            asOpaque: true
                        },
                        a: {
                            type: "number",
                            asOpaque: true
                        },
                        b: {
                            type: "number",
                            asOpaque: true
                        }
                    },
                    required: ["arr", "a", "b"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                arr: state.arr,
                a: state.a,
                b: state.b
            } }, ({ state }) => state.arr[state.a]! * state.arr[state.b]!)}</p>

        {/* Element access with string concatenation */}
        <p>Concat: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        items: {
                            type: "array",
                            items: {
                                type: "string"
                            },
                            asOpaque: true
                        },
                        indices: {
                            type: "array",
                            items: {
                                type: "number"
                            },
                            asOpaque: true
                        }
                    },
                    required: ["items", "indices"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                items: state.items,
                indices: state.indices
            } }, ({ state }) => state.items[0]! + " - " + state.items[state.indices[0]!]!)}</p>

        {/* Multiple element accesses in single expression */}
        <p>Sum: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        arr: {
                            type: "array",
                            items: {
                                type: "number"
                            },
                            asOpaque: true
                        }
                    },
                    required: ["arr"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                arr: state.arr
            } }, ({ state }) => state.arr[0]! + state.arr[1]! + state.arr[2]!)}</p>
      </div>),
    };
}, {
    type: "object",
    properties: {
        matrix: {
            type: "array",
            items: {
                type: "array",
                items: {
                    type: "number"
                }
            }
        },
        row: {
            type: "number"
        },
        col: {
            type: "number"
        },
        items: {
            type: "array",
            items: {
                type: "string"
            }
        },
        arr: {
            type: "array",
            items: {
                type: "number"
            }
        },
        a: {
            type: "number"
        },
        b: {
            type: "number"
        },
        indices: {
            type: "array",
            items: {
                type: "number"
            }
        },
        nested: {
            type: "object",
            properties: {
                arrays: {
                    type: "array",
                    items: {
                        type: "array",
                        items: {
                            type: "string"
                        }
                    }
                },
                index: {
                    type: "number"
                }
            },
            required: ["arrays", "index"]
        },
        users: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    },
                    scores: {
                        type: "array",
                        items: {
                            type: "number"
                        }
                    }
                },
                required: ["name", "scores"]
            }
        },
        selectedUser: {
            type: "number"
        },
        selectedScore: {
            type: "number"
        }
    },
    required: ["matrix", "row", "col", "items", "arr", "a", "b", "indices", "nested", "users", "selectedUser", "selectedScore"]
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
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
