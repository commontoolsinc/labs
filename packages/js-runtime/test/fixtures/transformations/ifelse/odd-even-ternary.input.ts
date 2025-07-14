/// <cts-enable />
import { derive, h, handler, NAME, recipe, schema, str, UI } from "commontools";

const model = schema({
  type: "object",
  properties: {
    value: { type: "number", default: 0, asCell: true },
  },
  default: { value: 0 },
});

export default recipe(model, model, (cell) => {
  const odd = derive(cell.value, (value) => value % 2);
  const label = odd ? "odd" : "even";

  return {
    [UI]: label,
    value: cell.value,
  };
});