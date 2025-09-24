/// <cts-enable />
import { Cell, derive, h, handler, NAME, recipe, str, UI } from "commontools";

const adder = handler((_, state: { values: Cell<string[]> }) => {
  state.values.push(Math.random().toString(36).substring(2, 15));
});

export default recipe<{ values: string[] }>(
  "Simple Value",
  ({ values }) => {
    derive(values, (values) => {
      console.log("values#", values?.length);
    });
    return {
      [NAME]: str`Simple Value: ${values.length || 0}`,
      [UI]: (
        <div>
          <button type="button" onClick={adder({ values })}>Add Value</button>
          <div>
            {values.map((value, index) => (
              <div>
                {index}: {value}
              </div>
            ))}
          </div>
        </div>
      ),
      values,
    };
  },
);