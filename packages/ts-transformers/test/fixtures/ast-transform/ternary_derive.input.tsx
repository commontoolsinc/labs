/// <cts-enable />
import { Default, NAME, pattern, UI } from "commontools";

interface PatternState {
  value: Default<number, 0>;
}

export default pattern<PatternState>("Counter", (state) => {
  return {
    [NAME]: "test ternary with derive",
    [UI]: (
      <div>
        {state.value + 1 ? state.value + 2 : "undefined"}
      </div>
    ),
  };
});
