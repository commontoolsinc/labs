/// <cts-enable />
import { derive, NAME, pattern, str, UI } from "commontools";
import "commontools/schema";
import { decrement, increment, model } from "./utils.ts";

export const customPatternExport = pattern(
  (cell) => {
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
      stringField: cell.stringField,
      numberField: cell.numberField,
      booleanField: cell.booleanField,
      arrayField: cell.arrayField,
      userData: cell.userData,
      listField: cell.listField,
    };
  },
  model,
  model,
);
