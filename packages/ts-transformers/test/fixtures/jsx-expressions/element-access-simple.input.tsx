/// <cts-enable />
import { h, recipe, UI, derive, ifElse, JSONSchema } from "commontools";

interface State {
  items: string[];
  index: number;
  matrix: number[][];
  row: number;
  col: number;
}

export default recipe<State>("ElementAccessSimple", (state) => {
  return {
    [UI]: (
      <div>
        <h3>Dynamic Element Access</h3>
        {/* Basic dynamic index */}
        <p>Item: {state.items[state.index]}</p>

        {/* Computed index */}
        <p>Last: {state.items[state.items.length - 1]}</p>

        {/* Double indexing */}
        <p>Matrix: {state.matrix[state.row][state.col]}</p>
      </div>
    ),
  };
});