/// <cts-enable />
import { pattern, type JSONSchema } from "commontools";
import "commontools/schema";

// Test that pattern with both schemas already present is not transformed
interface Input { count: number }
interface Result { doubled: number }

export default pattern<Input, Result>(
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
