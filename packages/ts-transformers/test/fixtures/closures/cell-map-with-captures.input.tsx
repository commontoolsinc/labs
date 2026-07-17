import { Cell, cell, pattern, UI } from "commonfabric";

interface State {
  values: number[];
  multiplier: number;
}

// FIXTURE: cell-map-with-captures
// Verifies: Cell.map() with outer-scope captures is transformed to mapWithPattern with params
//   typedValues.map((value) => <span>{value * state.multiplier}</span>)
//     → typedValues.mapWithPattern(pattern(...), { state: { multiplier: state.key("multiplier") } })
//   value * state.multiplier → lift(...)({ value, state: { multiplier } })
// Context: The map callback captures `state.multiplier` from the outer scope,
//   which must be threaded through as a mapWithPattern param and re-derived inside.
//   Cell initials are schema defaults and must be compile-time static
//   (CT-1880); the pattern-input value arrives via `.set(...)`.
export default pattern<State>((state) => {
  // Explicitly type as Cell to ensure closure transformation
  const typedValues: Cell<number[]> = cell<number[]>([]);
  typedValues.set(state.values);

  return {
    [UI]: (
      <div>
        {typedValues.map((value) => (
          <span>{value * state.multiplier}</span>
        ))}
      </div>
    ),
  };
});
