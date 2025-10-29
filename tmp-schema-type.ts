import type { Schema, JSONSchema, Cell, ID, ID_FIELD } from "./packages/api/index.ts";

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

type UserType = Result["user"];

const _user: UserType = {
  profile: {
    name: "John",
    metadata: {} as Cell<Record<string, unknown>>,
  },
};

const cell: Cell<Result> = null as any;
const userCell = cell.key("user");

type IsAny<T> = 0 extends (1 & T) ? true : false;

const _assertNotAny: IsAny<typeof userCell> extends false ? true : never = true;
