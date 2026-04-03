/// <cts-enable />
import { Default, NAME, pattern, UI } from "commonfabric";

interface PatternState {
  value: Default<number, 0>;
}

// FIXTURE: ternary_derive
// Verifies: ternary with expressions on both sides produces ifElse() with derive() for each branch
//   state.value + 1 ? state.value + 2 : "undefined" → ifElse(...schemas, derive(..., value+1), derive(..., value+2), "undefined")
//   pattern<PatternState>(fn)                        → pattern(fn, inputSchema, outputSchema)
// Context: Both condition and consequent contain state expressions that must be individually derive-wrapped
export default pattern<PatternState>((state) => {
  return {
    [NAME]: "test ternary with derive",
    [UI]: (
      <div>
        {state.value + 1 ? state.value + 2 : "undefined"}
      </div>
    ),
  };
});
