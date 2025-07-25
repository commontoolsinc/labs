/// <cts-enable />
import {
  Cell,
  Default,
  derive,
  h,
  handler,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

const updater = handler<{ newValues: string[] }, { values: Cell<string[]> }>(
  (event, state) => {
    console.log("updating values", event);
    event.newValues.forEach((value) => {
      console.log("adding value", value);
      state.values.push(value);
    });
  },
);

const adder = handler<unknown, { values: Cell<string[]> }>(
  (_, state) => {
    console.log("adding a value");
    state.values.push(Math.random().toString(36).substring(2, 15));
  },
);

export default recipe<{ values: Default<string[], []> }>(
  "simple",
  ({ values }) => {
    derive(values, (values) => {
      console.log("values#", values?.length);
    });
    return {
      [NAME]: str`Simple Value: ${
        derive(values, (values) => values?.length || 0)
      }`,
      [UI]: (
        <div>
          <ct-button onClick={adder({ values })}>Add Value</ct-button>
          <div>
            {values.map((value, index) => (
              <div>
                {index}: {value}
              </div>
            ))}
          </div>
        </div>
      ),
      updater: updater({ values }),
      values,
    };
  },
);
