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

type Keys = keyof Result;

const _assert: Keys extends "user" | typeof import("./packages/api/index.ts").ID | typeof import("./packages/api/index.ts").ID_FIELD ? true : false = true;
