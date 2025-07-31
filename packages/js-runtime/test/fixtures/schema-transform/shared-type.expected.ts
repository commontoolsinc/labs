/// <cts-enable />
import { type JSONSchema, recipe } from "commontools";

interface B {
  value: string;
}

interface A {
  b1: B;
  b2: B;
}

const schema = {
  "type": "object",
  "properties": {
    "b1": {
      "type": "object",
      "properties": {
        "value": {
          "type": "string"
        }
      },
      "required": ["value"]
    },
    "b2": {
      "type": "object",
      "properties": {
        "value": {
          "type": "string"
        }
      },
      "required": ["value"]
    }
  },
  "required": ["b1", "b2"]
} as const satisfies JSONSchema;

export default recipe("shared-type test", () => {
  return { schema };
});