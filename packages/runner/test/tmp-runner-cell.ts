import type { Cell } from "../src/cell.ts";
import type { JSONSchema } from "../src/builder/types.ts";

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

declare const c: Cell<{ id: number }>;

declare const cell: Cell<
  import("../src/builder/types.ts").Schema<typeof schema>
>;

const userCell = cell.key("user");

type IsAny<T> = 0 extends (1 & T) ? true : false;

const _assertNotAny: IsAny<typeof userCell> extends false ? true : never = true;
