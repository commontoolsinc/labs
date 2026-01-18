/// <cts-enable />
import { recipe, type JSONSchema } from "commontools";
import "commontools/schema";

// Test that recipe with both schemas already present is not transformed
export default recipe(
  {
    type: "object",
    properties: {
      count: { type: "number" }
    },
    required: ["count"]
  } as const satisfies JSONSchema,
  {
    type: "object",
    properties: {
      doubled: { type: "number" }
    },
    required: ["doubled"]
  } as const satisfies JSONSchema,
  ({ count }) => {
    return {
      doubled: count * 2
    };
  }
);
