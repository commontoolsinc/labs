// Note: This shows the key transformation - the actual output is AMD format
import { derive, h, handler, NAME, recipe, schema, str, UI, ifElse } from "commontools";

const model = schema({
  type: "object",
  properties: {
    value: { type: "number", default: 0, asCell: true },
  },
  default: { value: 0 },
});

export default recipe(model, model, (cell) => {
  const odd = derive(cell.value, (value) => value % 2);
  const label = commontools_1.ifElse(odd, "odd", "even");

  return {
    [UI]: label,
    value: cell.value,
  };
});