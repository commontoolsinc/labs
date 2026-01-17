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

// Define items schema separately to avoid deep type instantiation (TS2589)
const MentionableItemSchema: JSONSchema = {
  type: "object",
  properties: {
    [NAME]: { type: "string" },
  },
  required: [NAME],
  asCell: true,
};

export const MentionableArraySchema: JSONSchema = {
  type: "array",
  // Include MentionableSchema to sync NAME property
  // AND asCell: true to get CellHandles with proper IDs
  items: MentionableItemSchema,
};
