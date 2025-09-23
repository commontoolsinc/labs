/// <cts-enable />
import { h, recipe, UI, derive, ifElse, JSONSchema } from "commontools";
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
} as const satisfies JSONSchema, (state) => {
    return {
        [UI]: (<div>
        <h3>Nested Element Access</h3>
        {/* Double indexing into matrix */}
        <p>Matrix value: {commontools_1.derive({ state_matrix: state.matrix, state_row: state.row, state_col: state.col }, ({ state_matrix: _v1, state_row: _v2, state_col: _v3 }) => _v1[_v2][_v3])}</p>

        {/* Triple nested access */}
        <p>Deep nested: {commontools_1.derive({ state_nested_arrays: state.nested.arrays, state_nested_index: state.nested.index, state_row: state.row }, ({ state_nested_arrays: _v1, state_nested_index: _v2, state_row: _v3 }) => _v1[_v2][_v3])}</p>

        <h3>Multiple References to Same Array</h3>
        {/* Same array accessed multiple times with different indices */}
        <p>First and last: {state.items[0]} and {commontools_1.derive({ state_items: state.items, state_items_length: state.items.length }, ({ state_items: _v1, state_items_length: _v2 }) => _v1[_v2 - 1])}</p>

        {/* Array used in computation and access */}
        <p>Sum of ends: {commontools_1.derive({ state_arr: state.arr, state_arr_length: state.arr.length }, ({ state_arr: _v1, state_arr_length: _v2 }) => _v1[0] + _v1[_v2 - 1])}</p>

        <h3>Computed Indices</h3>
        {/* Index from multiple state values */}
        <p>Computed index: {commontools_1.derive({ state_arr: state.arr, state_a: state.a, state_b: state.b }, ({ state_arr: _v1, state_a: _v2, state_b: _v3 }) => _v1[_v2 + _v3])}</p>

        {/* Index from computation involving array */}
        <p>Modulo index: {commontools_1.derive({ state_items: state.items, state_row: state.row, state_items_length: state.items.length }, ({ state_items: _v1, state_row: _v2, state_items_length: _v3 }) => _v1[_v2 % _v3])}</p>

        {/* Complex index expression */}
        <p>Complex: {commontools_1.derive({ state_arr: state.arr, state_a: state.a, state_arr_length: state.arr.length }, ({ state_arr: _v1, state_a: _v2, state_arr_length: _v3 }) => _v1[Math.min(_v2 * 2, _v3 - 1)])}</p>

        <h3>Chained Element Access</h3>
        {/* Element access returning array, then accessing that */}
        <p>User score: {commontools_1.derive({ state_users: state.users, state_selectedUser: state.selectedUser, state_selectedScore: state.selectedScore }, ({ state_users: _v1, state_selectedUser: _v2, state_selectedScore: _v3 }) => _v1[_v2].scores[_v3])}</p>

        {/* Using one array element as index for another */}
        <p>Indirect: {commontools_1.derive({ state_items: state.items, state_indices: state.indices }, ({ state_items: _v1, state_indices: _v2 }) => _v1[_v2[0]])}</p>

        {/* Array element used as index for same array */}
        <p>Self reference: {commontools_1.derive(state.arr, _v1 => _v1[_v1[0]])}</p>

        <h3>Mixed Property and Element Access</h3>
        {/* Property access followed by element access with computed index */}
        <p>Mixed: {commontools_1.derive({ state_nested_arrays: state.nested.arrays, state_nested_index: state.nested.index }, ({ state_nested_arrays: _v1, state_nested_index: _v2 }) => _v1[_v2].length)}</p>

        {/* Element access followed by property access */}
        <p>User name length: {commontools_1.derive({ state_users: state.users, state_selectedUser: state.selectedUser }, ({ state_users: _v1, state_selectedUser: _v2 }) => _v1[_v2].name.length)}</p>

        <h3>Element Access in Conditions</h3>
        {/* Element access in ternary */}
        <p>Conditional: {commontools_1.ifElse(commontools_1.derive({ state_arr: state.arr, state_a: state.a }, ({ state_arr: _v1, state_a: _v2 }) => _v1[_v2] > 10), commontools_1.derive({ state_items: state.items, state_b: state.b }, ({ state_items: _v1, state_b: _v2 }) => _v1[_v2]), state.items[0])}</p>

        {/* Element access in boolean expression */}
        <p>Has value: {ifElse(commontools_1.derive({ state_matrix: state.matrix, state_row: state.row, state_col: state.col }, ({ state_matrix: _v1, state_row: _v2, state_col: _v3 }) => _v1[_v2][_v3] > 0), "positive", "non-positive")}</p>

        <h3>Element Access with Operators</h3>
        {/* Element access with arithmetic */}
        <p>Product: {commontools_1.derive({ state_arr: state.arr, state_a: state.a, state_b: state.b }, ({ state_arr: _v1, state_a: _v2, state_b: _v3 }) => _v1[_v2] * _v1[_v3])}</p>

        {/* Element access with string concatenation */}
        <p>Concat: {commontools_1.derive({ state_items: state.items, state_indices: state.indices }, ({ state_items: _v1, state_indices: _v2 }) => _v1[0] + " - " + _v1[_v2[0]])}</p>

        {/* Multiple element accesses in single expression */}
        <p>Sum: {commontools_1.derive(state.arr, _v1 => _v1[0] + _v1[1] + _v1[2])}</p>
      </div>),
    };
});

