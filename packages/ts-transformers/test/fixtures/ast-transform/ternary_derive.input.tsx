/// <cts-enable />
import {
  Cell,
  Default,
  derive,
  h,
  handler,
  NAME,
  Opaque,
  OpaqueRef,
  recipe,
  str,
  UI,
} from "commontools";

interface RecipeState {
  value: Default<number, 0>;
}

export default recipe<RecipeState>("Counter", (state) => {
  return {
    [NAME]: "test ternary with derive",
    [UI]: (
      <div>
          { state.value + 1 ? state.value + 2 : "undefined"}
      </div>
    ),
  };
});
