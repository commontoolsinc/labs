import { type JSONSchema, NAME } from "@commontools/runner/shared";

export interface Mentionable {
  [NAME]: string;
  [key: string]: unknown;
}

export type MentionableArray = readonly Mentionable[];

export const MentionableSchema = {
  type: "object",
  properties: {
    [NAME]: { type: "string" },
  },
  required: [NAME],
  // While Mentionable may have extra properies on it,
  // we don't need to sync them when using in UI code
  // additionalProperties: true,
} as const satisfies JSONSchema;

export const MentionableArraySchema = {
  type: "array",
  items: MentionableSchema,
} as const satisfies JSONSchema;
