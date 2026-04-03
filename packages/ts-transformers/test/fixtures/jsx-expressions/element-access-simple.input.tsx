/// <cts-enable />
import { pattern, UI } from "commontools";

interface State {
  items: string[];
  index: number;
  matrix: number[][];
  row: number;
  col: number;
}

// FIXTURE: element-access-simple
// Verifies: dynamic element access on reactive arrays is wrapped in derive()
//   state.items[state.index]            → derive({items, index}, ({state}) => state.items[state.index])
//   state.items[state.items.length - 1] → derive({items}, ...)
//   state.matrix[state.row]![state.col] → derive({matrix, row, col}, ...)
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        <h3>Dynamic Element Access</h3>
        {/* Basic dynamic index */}
        <p>Item: {state.items[state.index]}</p>

        {/* Computed index */}
        <p>Last: {state.items[state.items.length - 1]}</p>

        {/* Double indexing */}
        <p>Matrix: {state.matrix[state.row]![state.col]}</p>
      </div>
    ),
  };
});
