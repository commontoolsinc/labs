/// <cts-enable />
import { pattern, UI } from "commontools";

interface State {
  items: number[];
  threshold: number;
  factor: number;
}

// FIXTURE: jsx-array-method-sink-calls
// Verifies: direct JSX sink receiver-methods over structural array-method chains can use the shared post-closure path
//   state.items.filter(fn).join(", ")           → shared post-closure derive over the final join call
//   state.items.filter(fn).map(fn).join(", ")   → shared post-closure derive over the final join call
//   state.items.filter(fn).join(", ").toUpperCase() stays on the older JSX seam for now
// Context: Isolates the residual array-method-subexpression sink cases from broader method-chain coverage
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        <p>
          Filter joined:{" "}
          {state.items.filter((x) => x > state.threshold).join(", ")}
        </p>
        <p>
          Filter map joined:{" "}
          {state.items.filter((x) => x > state.threshold).map((x) =>
            x * state.factor
          ).join(", ")}
        </p>
        <p>
          Filter joined upper:{" "}
          {state.items.filter((x) => x > state.threshold).join(", ").toUpperCase()}
        </p>
      </div>
    ),
  };
});
