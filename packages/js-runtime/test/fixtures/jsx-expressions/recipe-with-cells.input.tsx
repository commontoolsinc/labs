/// <cts-enable />
import {  h, recipe, UI } from "commontools";

export default recipe<{ value: number }>("simple-recipe", (cell) => {
  return {
    [UI]: (
      <div>
        <p>Current value: {cell.value}</p>
        <p>Next value: {cell.value + 1}</p>
        <p>Double: {cell.value * 2}</p>
      </div>
    ),
    value: cell.value,
  };
});