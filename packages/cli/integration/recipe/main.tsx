// deno-lint-ignore-file jsx-no-useless-fragment
import { derive, h, NAME, recipe, str, UI } from "commontools";
import { decrement, increment, model } from "./utils.ts";

export const customRecipeExport = recipe(model, model, (cell) => {
  return {
    [NAME]: str`Simple counter: ${derive(cell.value, String)}`,
    [UI]: (
      <div>
        <ct-button onClick={decrement(cell)}>-</ct-button>
        {/* use html fragment to test that it works  */}
        <>
          <b>{cell.value}</b>
        </>
        <ct-button onClick={increment(cell)}>+</ct-button>
      </div>
    ),
    value: cell.value,
  };
});
