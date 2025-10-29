import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
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
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        <h3>Dynamic Element Access</h3>
        {/* Basic dynamic index */}
        <p>Item: {__ctHelpers.derive({ state: {
                items: state.items,
                index: state.index
            } }, state => state.items[state.index])}</p>

        {/* Computed index */}
        <p>Last: {__ctHelpers.derive({ state: {
                items: state.items
            } }, state => state.items[state.items.length - 1])}</p>

        {/* Double indexing */}
        <p>Matrix: {__ctHelpers.derive({ state: {
                matrix: state.matrix,
                row: state.row,
                col: state.col
            } }, state => state.matrix[state.row][state.col])}</p>
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
