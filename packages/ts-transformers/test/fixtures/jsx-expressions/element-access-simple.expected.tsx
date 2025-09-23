/// <cts-enable />
import { h, recipe, UI, derive, ifElse, JSONSchema } from "commontools";
interface State {
    items: string[];
    index: number;
    matrix: number[][];
    row: number;
    col: number;
}
export default recipe({
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "string"
            }
        },
        index: {
            type: "number"
        },
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
        }
    },
    required: ["items", "index", "matrix", "row", "col"]
} as const satisfies JSONSchema, (state) => {
    return {
        [UI]: (<div>
        <h3>Dynamic Element Access</h3>
        {/* Basic dynamic index */}
        <p>Item: {commontools_1.derive({ state_items: state.items, state_index: state.index }, ({ state_items: _v1, state_index: _v2 }) => _v1[_v2])}</p>

        {/* Computed index */}
        <p>Last: {commontools_1.derive({ state_items: state.items, state_items_length: state.items.length }, ({ state_items: _v1, state_items_length: _v2 }) => _v1[_v2 - 1])}</p>

        {/* Double indexing */}
        <p>Matrix: {commontools_1.derive({ state_matrix: state.matrix, state_row: state.row, state_col: state.col }, ({ state_matrix: _v1, state_row: _v2, state_col: _v3 }) => _v1[_v2][_v3])}</p>
      </div>),
    };
});
