// Test file with named export instead of default export
/// <cts-enable />
import { pattern, schema } from "commontools";
import "commontools/schema";

const model = schema({
  type: "object",
  properties: {
    message: { type: "string", default: "from named export" },
  },
  default: { message: "from named export" },
});

export const myNamedPattern = pattern(
  (cell) => {
    return {
      message: cell.message,
    };
  },
  model,
  model,
);

export default pattern(
  (_cell) => {
    return {
      message: "from default export",
    };
  },
  model,
  model,
);
