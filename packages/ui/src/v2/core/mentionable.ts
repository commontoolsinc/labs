import { type JSONSchema, NAME } from "@commontools/runner/shared";

export interface Mentionable {
  [NAME]: string;
  [key: string]: unknown;
}

export type MentionableArray = Mentionable[];

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

// Use explicit type annotation to avoid TS2589 "Type instantiation is excessively deep"
// The asCell: true ensures array items are CellHandles with proper IDs for .equals() comparison
export const MentionableArraySchema: JSONSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      [NAME]: { type: "string" },
    },
    required: [NAME],
    asCell: true,
  },
};
