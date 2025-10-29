import * as __ctHelpers from "commontools";
import { ifElse, recipe, UI } from "commontools";
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
export default recipe({
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
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        <h3>Nested Element Access</h3>
        {/* Double indexing into matrix */}
        <p>Matrix value: {__ctHelpers.derive({ state: {
                matrix: state.matrix,
                row: state.row,
                col: state.col
            } }, state => state.matrix[state.row][state.col])}</p>

        {/* Triple nested access */}
        <p>Deep nested: {__ctHelpers.derive({ state: {
                nested: {
                    arrays: state.nested.arrays,
                    index: state.nested.index
                },
                row: state.row
            } }, state => state.nested.arrays[state.nested.index][state.row])}</p>

        <h3>Multiple References to Same Array</h3>
        {/* Same array accessed multiple times with different indices */}
        <p>
          First and last: {state.items[0]} and{" "}
          {__ctHelpers.derive({ state: {
                items: state.items
            } }, state => state.items[state.items.length - 1])}
        </p>

        {/* Array used in computation and access */}
        <p>Sum of ends: {__ctHelpers.derive({ state: {
                arr: state.arr
            } }, state => state.arr[0] + state.arr[state.arr.length - 1])}</p>

        <h3>Computed Indices</h3>
        {/* Index from multiple state values */}
        <p>Computed index: {__ctHelpers.derive({ state: {
                arr: state.arr,
                a: state.a,
                b: state.b
            } }, state => state.arr[state.a + state.b])}</p>

        {/* Index from computation involving array */}
        <p>Modulo index: {__ctHelpers.derive({ state: {
                items: state.items,
                row: state.row
            } }, state => state.items[state.row % state.items.length])}</p>

        {/* Complex index expression */}
        <p>Complex: {__ctHelpers.derive({ state: {
                arr: state.arr,
                a: state.a
            } }, state => state.arr[Math.min(state.a * 2, state.arr.length - 1)])}</p>

        <h3>Chained Element Access</h3>
        {/* Element access returning array, then accessing that */}
        <p>
          User score:{" "}
          {__ctHelpers.derive({ state: {
                users: state.users,
                selectedUser: state.selectedUser,
                selectedScore: state.selectedScore
            } }, state => state.users[state.selectedUser].scores[state.selectedScore])}
        </p>

        {/* Using one array element as index for another */}
        <p>Indirect: {__ctHelpers.derive({ state: {
                items: state.items,
                indices: state.indices
            } }, state => state.items[state.indices[0]])}</p>

        {/* Array element used as index for same array */}
        <p>Self reference: {__ctHelpers.derive({ state: {
                arr: state.arr
            } }, state => state.arr[state.arr[0]])}</p>

        <h3>Mixed Property and Element Access</h3>
        {/* Property access followed by element access with computed index */}
        <p>Mixed: {__ctHelpers.derive({ state: {
                nested: {
                    arrays: state.nested.arrays,
                    index: state.nested.index
                }
            } }, state => state.nested.arrays[state.nested.index].length)}</p>

        {/* Element access followed by property access */}
        <p>User name length: {__ctHelpers.derive({ state: {
                users: state.users,
                selectedUser: state.selectedUser
            } }, state => state.users[state.selectedUser].name.length)}</p>

        <h3>Element Access in Conditions</h3>
        {/* Element access in ternary */}
        <p>
          Conditional:{" "}
          {__ctHelpers.ifElse(__ctHelpers.derive({ state: {
                arr: state.arr,
                a: state.a
            } }, state => state.arr[state.a] > 10), __ctHelpers.derive({ state: {
                items: state.items,
                b: state.b
            } }, state => state.items[state.b]), state.items[0])}
        </p>

        {/* Element access in boolean expression */}
        <p>
          Has value: {ifElse(__ctHelpers.derive({ state: {
                matrix: state.matrix,
                row: state.row,
                col: state.col
            } }, state => state.matrix[state.row][state.col] > 0), "positive", "non-positive")}
        </p>

        <h3>Element Access with Operators</h3>
        {/* Element access with arithmetic */}
        <p>Product: {__ctHelpers.derive({ state: {
                arr: state.arr,
                a: state.a,
                b: state.b
            } }, state => state.arr[state.a] * state.arr[state.b])}</p>

        {/* Element access with string concatenation */}
        <p>Concat: {__ctHelpers.derive({ state: {
                items: state.items,
                indices: state.indices
            } }, state => state.items[0] + " - " + state.items[state.indices[0]])}</p>

        {/* Multiple element accesses in single expression */}
        <p>Sum: {__ctHelpers.derive({ state: {
                arr: state.arr
            } }, state => state.arr[0] + state.arr[1] + state.arr[2])}</p>
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
