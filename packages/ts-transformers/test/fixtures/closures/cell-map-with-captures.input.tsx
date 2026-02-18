/// <cts-enable />
import { Cell, cell, pattern, UI } from "commontools";

interface State {
  values: number[];
  multiplier: number;
}

export default pattern<State>((state) => {
  // Explicitly type as Cell to ensure closure transformation
  const typedValues: Cell<number[]> = cell(state.values);

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
