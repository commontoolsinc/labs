/// <cts-enable />
// Note: This is a simplified representation of the expected transformation
// The actual output would be AMD module format, but this shows the key transformations
import { derive, h, recipe, schema, UI } from "commontools";

const model = schema({
  type: "object",
  properties: {
    value: { type: "number", default: 0, asCell: true },
  },
  default: { value: 0 },
});

export default recipe(model, model, (cell) => {
  return {
    [UI]: (
      commontools_1.h("div", null,
        commontools_1.h("p", null,
          "Current value: ",
          cell.value),
        commontools_1.h("p", null,
          "Next value: ",
          commontools_1.derive(cell.value, _v1 => _v1 + 1)),
        commontools_1.h("p", null,
          "Double: ",
          commontools_1.derive(cell.value, _v1 => _v1 * 2)))
    ),
    value: cell.value,
  };
});