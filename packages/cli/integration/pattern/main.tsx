/// <cts-enable />
import {
  derive,
  NAME,
  pattern,
  str,
  type Stream,
  UI,
  type VNode,
} from "commontools";
import {
  type CounterInput,
  decrement,
  increment,
  type UserData,
} from "./utils.ts";

interface CounterOutput {
  [NAME]: string;
  [UI]: VNode;
  increment: Stream<void>;
  decrement: Stream<void>;
  value: number;
  stringField?: string;
  numberField?: number;
  booleanField?: boolean;
  arrayField?: number[];
  userData?: UserData;
  listField?: string[];
}

export const customPatternExport = pattern<CounterInput, CounterOutput>(
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
      increment: increment(cell),
      decrement: decrement(cell),
      value: cell.value,
      stringField: cell.stringField,
      numberField: cell.numberField,
      booleanField: cell.booleanField,
      arrayField: cell.arrayField,
      userData: cell.userData,
      listField: cell.listField,
    };
  },
);
