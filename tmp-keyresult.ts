import type {
  KeyResultType,
  AsCell,
  Cell,
} from "./packages/api/index.ts";
import type { Schema, JSONSchema } from "./packages/api/index.ts";

const schema = {
  type: "object",
  properties: {
    user: {
      type: "object",
      properties: {
        profile: {
          type: "object",
          properties: {
            name: { type: "string" },
            metadata: {
              type: "object",
              asCell: true,
            },
          },
          required: ["name", "metadata"],
        },
      },
      required: ["profile"],
    },
  },
  required: ["user"],
} as const satisfies JSONSchema;

type Result = Schema<typeof schema>;

type UserKeyResult = KeyResultType<Result, "user", AsCell>;

type Expected = Cell<{
  profile: {
    name: string;
    metadata: Cell<Record<string, unknown>>;
  };
}>;

const _assert: UserKeyResult extends Expected ? true : false = true;
const _assert2: Expected extends UserKeyResult ? true : false = true;
