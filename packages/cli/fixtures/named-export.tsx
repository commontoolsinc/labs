// Test file with named export instead of default export
import { h, recipe, schema } from "commontools";

const model = schema({
  type: "object",
  properties: {
    message: { type: "string", default: "from named export" },
  },
  default: { message: "from named export" },
});

export const myNamedRecipe = recipe(model, model, (cell) => {
  return {
    message: cell.message,
  };
});

export default recipe(model, model, (cell) => {
  return {
    message: "from default export",
  };
});
