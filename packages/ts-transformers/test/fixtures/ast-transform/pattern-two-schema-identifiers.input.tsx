/// <cts-enable />
import { computed, pattern, type JSONSchema } from "commontools";
import "commontools/schema";

interface Input {
  count: number;
}

interface Result {
  doubled: number;
}

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    count: { type: "number" },
  },
  required: ["count"],
} as const satisfies JSONSchema;

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    doubled: { type: "number" },
  },
  required: ["doubled"],
} as const satisfies JSONSchema;

// FIXTURE: pattern-two-schema-identifiers
// Verifies: explicit schema identifiers are preserved even when type args are present
export default pattern<Input, Result>(
  ({ count }) => {
    return {
      doubled: computed(() => count * 2),
    };
  },
  INPUT_SCHEMA,
  RESULT_SCHEMA,
);
