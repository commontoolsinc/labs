import { type JSONSchema, NAME, type Schema } from "@commontools/api";

export const mentionableArraySchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      [NAME]: { type: "string" },
      items: { $ref: "#", asCell: true },
    },
    required: [NAME],
  },
} as const satisfies JSONSchema;

export type MentionableArray = Schema<typeof mentionableArraySchema>;
export type Mentionable = MentionableArray[0];
